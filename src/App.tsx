import { useCallback, useEffect, useRef, useState } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import { QRCodeSVG } from 'qrcode.react'
import type { ObjectDetection } from '@tensorflow-models/coco-ssd'

// コップ検出モデル（COCO-SSD）は1回だけ読み込み、全VideoPanelで共有する
// TensorFlowは重いので、PC画面でだけ動的importする（スマホ画面は軽いまま）
let modelPromise: Promise<ObjectDetection> | null = null
function loadCupModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [tf, cocoSsd] = await Promise.all([
        import('@tensorflow/tfjs'),
        import('@tensorflow-models/coco-ssd'),
      ])
      await tf.ready()
      return cocoSsd.load()
    })()
  }
  return modelPromise
}

// 位置とサイズは映像の幅・高さに対する % で持つ（表示サイズが変わってもずれない）
type Box = { x: number; y: number; w: number; h: number; score: number }
type CountKind = 'cups' | 'glasses'

// メガネ検出（OWL-ViT）は Web Worker 1つで動かし、全VideoPanelで共有する
let glassesWorker: Worker | null = null
let glassesReadyPromise: Promise<void> | null = null
let nextRequestId = 0
const pendingRequests = new Map<number, (boxes: Box[]) => void>()

function loadGlassesModel() {
  if (!glassesReadyPromise) {
    glassesReadyPromise = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./glassesWorker.ts', import.meta.url), {
        type: 'module',
      })
      glassesWorker = worker
      worker.onmessage = (e) => {
        const msg = e.data
        if (msg.type === 'ready') resolve()
        if (msg.type === 'error') reject(new Error(msg.message))
        if (msg.type === 'result') {
          if (msg.error) console.error('メガネ検出エラー:', msg.error)
          pendingRequests.get(msg.id)?.(msg.boxes)
          pendingRequests.delete(msg.id)
        }
      }
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'))
    })
  }
  return glassesReadyPromise
}

async function detectGlasses(video: HTMLVideoElement): Promise<Box[]> {
  if (!glassesWorker) return []
  // 映像の1コマを幅640pxに縮小して Worker に渡す
  const scale = Math.min(1, 640 / video.videoWidth)
  const bitmap = await createImageBitmap(video, {
    resizeWidth: Math.round(video.videoWidth * scale),
    resizeHeight: Math.round(video.videoHeight * scale),
  })
  const id = nextRequestId++
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve)
    glassesWorker!.postMessage({ type: 'detect', id, bitmap }, [bitmap])
  })
}

function Smartphone({ hostId }: { hostId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DataConnection | null>(null)
  const [cameraSettings, setCameraSettings] = useState<MediaTrackSettings | null>(null)
  const [message, setMessage] = useState('ドン！')
  const [cupCount, setCupCount] = useState<number | null>(null)
  const [glassesCount, setGlassesCount] = useState<number | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    const peer = new Peer()

    function tryCall() {
      if (peer.open && stream) {
        peer.call(hostId, stream)

        const conn = peer.connect(hostId)
        conn.on('open', () => {
          connRef.current = conn
          conn.send('接続完了!')
        })
        // PCから届く数 { cups: N } または { glasses: N }
        conn.on('data', (data) => {
          if (data && typeof data === 'object') {
            if ('cups' in data) setCupCount(Number(data.cups))
            if ('glasses' in data) setGlassesCount(Number(data.glasses))
          }
        })
        conn.on('close', () => {
          if (connRef.current == conn) {
            connRef.current = null
          }
        })
      }
    }

    peer.on('open', () => {
      tryCall()
    })


    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' }, // 前面（自撮り）カメラ
          audio: false,
        })
        setCameraSettings(stream.getVideoTracks()[0].getSettings())

        if (peer.destroyed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
        tryCall()

      } catch (error) {
        console.error('カメラの取得に失敗しました', error)
      }
    }
    startCamera()

    return () => {
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      connRef.current = null
      peer.destroy()
    }
  }, [hostId])

  return (
    <div
      onClick={() => {
        if (connRef.current && connRef.current.open) {
          connRef.current.send(message)
        }
      }}
      className="h-dvh overflow-hidden bg-blue-100 p-4"
    >
      <div className="flex flex-row items-center gap-4">
        <h1 className="mb-4 text-sm font-bold">
          スマホカメラ
        </h1>
        <p className="mb-4 break-all">
          接続先PC：{hostId}
        </p>
        {cupCount !== null && (
          <p className="mb-4 font-bold">☕ ×{cupCount}</p>
        )}
        {glassesCount !== null && (
          <p className="mb-4 font-bold">👓 ×{glassesCount}</p>
        )}
      </div>
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="mb-4 rounded border bg-white p-2"
        placeholder="送信する文字"
      />

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="rounded bg-black"
      />
      <pre className="mt-4 max-h-32 overflow-auto rounded text-xs">
        {JSON.stringify(cameraSettings)?.slice(1, -1).replaceAll(',', '\n')}
      </pre>
    </div>
  )
}

function VideoPanel({
  peerId,
  stream,
  effects,
  model,
  glassesReady,
  onCount,
}: {
  peerId: string
  stream: MediaStream
  effects: {
    id: number
    peerId: string
    text: string
    x: number
    y: number
  }[]
  model: ObjectDetection | null
  glassesReady: boolean
  onCount: (peerId: string, streamId: string, kind: CountKind, count: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cups, setCups] = useState<Box[]>([])
  const [glasses, setGlasses] = useState<Box[]>([])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch((err) => console.error('再生エラー:', err))
    }
  }, [stream])

  // 500msごとにコップを検出する（毎フレームではない）
  useEffect(() => {
    if (!model) return
    let cancelled = false
    let busy = false
    let lastCount = -1

    const timer = setInterval(async () => {
      const video = videoRef.current
      if (busy || !video || video.readyState < 2 || video.videoWidth === 0) {
        return
      }
      busy = true
      try {
        const predictions = await model.detect(video)
        if (cancelled) return
        const found = predictions
          .filter((p) => p.class === 'cup' && p.score >= 0.5)
          .map((p) => ({
            x: (p.bbox[0] / video.videoWidth) * 100,
            y: (p.bbox[1] / video.videoHeight) * 100,
            w: (p.bbox[2] / video.videoWidth) * 100,
            h: (p.bbox[3] / video.videoHeight) * 100,
            score: p.score,
          }))
        setCups(found)
        if (found.length !== lastCount) {
          lastCount = found.length
          onCount(peerId, stream.id, 'cups', found.length)
        }
      } catch (err) {
        console.error('検出エラー:', err)
      } finally {
        busy = false
      }
    }, 500)

    // スマホが切断されてVideoPanelが消えたらタイマーを止める
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [model, stream, peerId, onCount])

  // メガネは重いモデルなので1.5秒ごと（前の検出が終わるまで次は始めない）
  useEffect(() => {
    if (!glassesReady) return
    let cancelled = false
    let busy = false
    let lastCount = -1

    const timer = setInterval(async () => {
      const video = videoRef.current
      if (busy || !video || video.readyState < 2 || video.videoWidth === 0) {
        return
      }
      busy = true
      try {
        const found = await detectGlasses(video)
        if (cancelled) return
        setGlasses(found)
        if (found.length !== lastCount) {
          lastCount = found.length
          onCount(peerId, stream.id, 'glasses', found.length)
        }
      } catch (err) {
        console.error('メガネ検出エラー:', err)
      } finally {
        busy = false
      }
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [glassesReady, stream, peerId, onCount])

  return (
    <div className="relative [container-type:inline-size]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="block w-full rounded bg-black"
      />

      {cups.map((cup, i) => (
        <div
          key={`cup-${i}`}
          className="pointer-events-none absolute border-2 border-yellow-400"
          style={{
            left: `${cup.x}%`,
            top: `${cup.y}%`,
            width: `${cup.w}%`,
            height: `${cup.h}%`,
          }}
        >
          <span className="absolute top-0 left-0 bg-yellow-400 px-1 text-[10px] font-bold whitespace-nowrap text-black">
            cup {Math.round(cup.score * 100)}%
          </span>
        </div>
      ))}

      {glasses.map((g, i) => (
        <div
          key={`glasses-${i}`}
          className="pointer-events-none absolute border-2 border-cyan-400"
          style={{
            left: `${g.x}%`,
            top: `${g.y}%`,
            width: `${g.w}%`,
            height: `${g.h}%`,
          }}
        >
          <span className="absolute top-0 left-0 bg-cyan-400 px-1 text-[10px] font-bold whitespace-nowrap text-black">
            glasses {Math.round(g.score * 100)}%
          </span>
        </div>
      ))}

      {(model || glassesReady) && (
        <div className="pointer-events-none absolute top-2 left-2 flex gap-2 rounded bg-black/60 px-2 py-1 text-sm font-bold text-white">
          {model && <span>☕ ×{cups.length}</span>}
          {glassesReady && <span>👓 ×{glasses.length}</span>}
        </div>
      )}

      {effects.map((effect) => (
        <span
          key={effect.id}
          className="pointer-events-none absolute animate-[floatUp_1s_ease-out_forwards] text-xs font-black text-white"
          style={{
            left: `${effect.x}%`,
            bottom: `${effect.y}%`,
          }}
        >
          {effect.text}
        </span>
      ))}
    </div>
  )
}
function App() {

  const [peerId, setPeerId] = useState('')
  const [videos, setVideos] = useState<
    { peerId: string; stream: MediaStream }[]
  >([])
  const [effects, setEffects] = useState<
    { id: number; peerId: string; text: string; x: number; y: number }[]
  >([])
  const [model, setModel] = useState<ObjectDetection | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [glassesReady, setGlassesReady] = useState(false)
  const [glassesError, setGlassesError] = useState<string | null>(null)
  // key: stream.id, value: 今映っているコップ・メガネの数
  const [counts, setCounts] = useState<
    Record<string, Partial<Record<CountKind, number>>>
  >({})
  // key: スマホのpeer ID（数をスマホへ送り返すため）
  const connectionsRef = useRef(new Map<string, DataConnection>())

  const smartphoneUrl = `${window.location.origin}${import.meta.env.BASE_URL}?host=${peerId}`

  function total(kind: CountKind) {
    return videos.reduce(
      (sum, video) => sum + (counts[video.stream.id]?.[kind] ?? 0),
      0
    )
  }

  const handleCount = useCallback(
    (phonePeerId: string, streamId: string, kind: CountKind, count: number) => {
      setCounts((prev) => ({
        ...prev,
        [streamId]: { ...prev[streamId], [kind]: count },
      }))
      const conn = connectionsRef.current.get(phonePeerId)
      if (conn && conn.open) {
        conn.send({ [kind]: count })
      }
    },
    []
  )

  useEffect(() => {
    let active = true
    loadCupModel()
      .then((loaded) => {
        if (active) setModel(loaded)
      })
      .catch((err) => {
        console.error('モデルの読み込みに失敗しました', err)
        if (active) setModelError(err instanceof Error ? err.message : String(err))
      })
    loadGlassesModel()
      .then(() => {
        if (active) setGlassesReady(true)
      })
      .catch((err) => {
        console.error('メガネモデルの読み込みに失敗しました', err)
        if (active) setGlassesError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const peer = new Peer()

    peer.on('open', (id) => {
      setPeerId(id)
    })

    peer.on('connection', (conn) => {
      connectionsRef.current.set(conn.peer, conn)
      conn.on('close', () => {
        if (connectionsRef.current.get(conn.peer) === conn) {
          connectionsRef.current.delete(conn.peer)
        }
      })
      conn.on('data', (data) => {
        setEffects((prev) => [
          ...prev,
          {
            id: Date.now() + Math.random(),
            peerId: conn.peer,
            text: String(data),
            x: 30 + Math.random() * 40,
            y: 10 + Math.random() * 20,
          },
        ])
      })
    })

    peer.on('call', (call) => {
      call.answer()

      let streamId: string | null = null

      function removeVideo() {
        if (streamId) {
          setVideos((prev) =>
            prev.filter((video) => video.stream.id !== streamId)
          )
        }
      }

      call.on('stream', (stream) => {
        streamId = stream.id
        setVideos((prev) => [...prev, { peerId: call.peer, stream }])

        const connection = call.peerConnection
        connection.addEventListener('connectionstatechange', () => {
          console.log(connection.connectionState)
          if (
            connection.connectionState === 'failed' ||
            connection.connectionState === 'closed'
          ) {
            removeVideo()
          }
        })
      })

      call.on('close', removeVideo)
    })

    return () => {
      peer.destroy()
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <h1 className="mb-4 text-2xl font-bold">
        スマホ映像モニター
      </h1>

      <p>PCのPeer ID：<span className="mt-2 break-all rounded bg-white p-4">
        {peerId || '接続待機中...'}
      </span></p>
      {!model && !modelError && (
        <p className="mt-4 text-sm text-gray-600">Loading model...</p>
      )}
      {modelError && (
        <p className="mt-4 text-sm text-red-600">
          Cup detection is not available (model failed to load): {modelError}
        </p>
      )}
      {!glassesReady && !glassesError && (
        <p className="mt-1 text-sm text-gray-600">
          Loading glasses model... (about 155 MB the first time)
        </p>
      )}
      {glassesError && (
        <p className="mt-1 text-sm text-red-600">
          Glasses detection is not available (model failed to load): {glassesError}
        </p>
      )}
      {peerId && (
        <div className="flex flex-row items-center gap-4">
          <div className="mt-6 inline-block rounded bg-white p-4">
            <a
              href={smartphoneUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block"
            >
              <QRCodeSVG
                value={smartphoneUrl}
                size={200}
              />
            </a>
          </div>
          <h2 className="mt-8 mb-4 text-xl font-bold">
            接続中のスマホ：{videos.length}台
          </h2>
          <h2 className="mt-8 mb-4 text-xl font-bold">
            Total cups: {total('cups')}
          </h2>
          <h2 className="mt-8 mb-4 text-xl font-bold">
            Total glasses: {total('glasses')}
          </h2>
        </div>
      )}

      <div className="grid grid-cols-2 items-start gap-4 md:grid-cols-3 lg:grid-cols-4">
        {videos.map((video) => (
          <VideoPanel
            key={video.stream.id}
            peerId={video.peerId}
            stream={video.stream}
            effects={effects.filter((effect) => effect.peerId === video.peerId)}
            model={model}
            glassesReady={glassesReady}
            onCount={handleCount}
          />
        ))}
      </div>
    </div>
  )
}

function Main() {
  const hostId = new URLSearchParams(window.location.search).get('host')
  return hostId ? <Smartphone hostId={hostId} /> : <App />
}

export default Main

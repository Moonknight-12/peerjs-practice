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
type CupBox = { x: number; y: number; w: number; h: number; score: number }

function Smartphone({ hostId }: { hostId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DataConnection | null>(null)
  const [cameraSettings, setCameraSettings] = useState<MediaTrackSettings | null>(null)
  const [message, setMessage] = useState('ドン！')
  const [cupCount, setCupCount] = useState<number | null>(null)

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
        // PCから届くコップの数 { cups: N }
        conn.on('data', (data) => {
          if (data && typeof data === 'object' && 'cups' in data) {
            setCupCount(Number(data.cups))
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
          video: { facingMode: 'environment' },
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
  onCupCount,
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
  onCupCount: (peerId: string, streamId: string, count: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cups, setCups] = useState<CupBox[]>([])

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
          onCupCount(peerId, stream.id, found.length)
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
  }, [model, stream, peerId, onCupCount])

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
          key={i}
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

      {model && (
        <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 text-sm font-bold text-white">
          ☕ ×{cups.length}
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
  // key: stream.id, value: 今映っているコップの数
  const [cupCounts, setCupCounts] = useState<Record<string, number>>({})
  // key: スマホのpeer ID（数をスマホへ送り返すため）
  const connectionsRef = useRef(new Map<string, DataConnection>())

  const smartphoneUrl = `${window.location.origin}${import.meta.env.BASE_URL}?host=${peerId}`

  const totalCups = videos.reduce(
    (sum, video) => sum + (cupCounts[video.stream.id] ?? 0),
    0
  )

  const handleCupCount = useCallback(
    (phonePeerId: string, streamId: string, count: number) => {
      setCupCounts((prev) => ({ ...prev, [streamId]: count }))
      const conn = connectionsRef.current.get(phonePeerId)
      if (conn && conn.open) {
        conn.send({ cups: count })
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
            Total cups: {totalCups}
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
            onCupCount={handleCupCount}
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

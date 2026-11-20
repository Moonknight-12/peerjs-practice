import { useCallback, useEffect, useRef, useState } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import { QRCodeSVG } from 'qrcode.react'
import type { FaceLandmarker } from '@mediapipe/tasks-vision'

// ===== お菓子キャッチゲームの設定 =====
const SNACK_EMOJIS = ['🍪', '🍩', '🍫', '🍬', '🍭', '🍿', '🍓', '🍙']
const SPAWN_MS = 1200 // お菓子が出てくる間隔
const RISE_MS = 4000 // 下から上まで移動する時間（index.css の snackRise と同じ動き）
const MOUTH_OPEN_RATIO = 0.07 // 唇のすき間 ÷ 顔の高さ がこれ以上なら「口が開いている」
const CATCH_RADIUS = 0.3 // 口からこの距離（顔の高さ × 0.3）以内のお菓子を食べられる

// お菓子の縦位置（%）。CSS の snackRise（top: 110% → -10%）と同じ計算
function snackY(born: number, now: number) {
  return 110 - (120 * (now - born)) / RISE_MS
}

// 顔のランドマーク検出（MediaPipe）は1回だけ読み込み、全VideoPanelで共有する
// package.json のバージョンと同じ番号にすること
const MEDIAPIPE_VERSION = '1.2.3'
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

let landmarkerPromise: Promise<FaceLandmarker> | null = null
function loadFaceLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
      )
      const create = (delegate: 'GPU' | 'CPU') =>
        vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
          runningMode: 'IMAGE', // 複数のスマホ映像で共有するので IMAGE モード
          numFaces: 1,
        })
      try {
        return await create('GPU')
      } catch {
        return create('CPU') // GPU が使えないPC用
      }
    })()
  }
  return landmarkerPromise
}

function Smartphone({ hostId }: { hostId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DataConnection | null>(null)
  const [cameraSettings, setCameraSettings] = useState<MediaTrackSettings | null>(null)
  const [message, setMessage] = useState('ドン！')
  const [snackCount, setSnackCount] = useState<number | null>(null)

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
        // PCから届く食べたお菓子の数 { snacks: N }
        conn.on('data', (data) => {
          if (data && typeof data === 'object' && 'snacks' in data) {
            setSnackCount(Number(data.snacks))
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
        {snackCount !== null && (
          <p className="mb-4 font-bold">🍪 ×{snackCount}</p>
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

type Snack = { id: number; emoji: string; x: number; born: number }
type Mouth = { x: number; y: number; r: number; open: boolean }

function VideoPanel({
  peerId,
  stream,
  effects,
  landmarker,
  onSnackCount,
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
  landmarker: FaceLandmarker | null
  onSnackCount: (peerId: string, streamId: string, count: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const snacksRef = useRef<Snack[]>([])
  const [snacks, setSnacks] = useState<Snack[]>([])
  const [mouth, setMouth] = useState<Mouth | null>(null)
  const [score, setScore] = useState(0)
  const [pops, setPops] = useState<{ id: number; x: number; y: number }[]>([])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch((err) => console.error('再生エラー:', err))
    }
  }, [stream])

  // ゲーム: お菓子を出す + 口の位置を調べて、口が開いていたら近くのお菓子を食べる
  useEffect(() => {
    if (!landmarker) return
    let total = 0
    let nextId = 0

    function updateSnacks(list: Snack[]) {
      snacksRef.current = list
      setSnacks(list)
    }

    // 一定間隔で下から新しいお菓子を出す（上まで行ったものは消す）
    const spawnTimer = setInterval(() => {
      const now = Date.now()
      updateSnacks([
        ...snacksRef.current.filter((s) => now - s.born < RISE_MS),
        {
          id: nextId++,
          emoji: SNACK_EMOJIS[Math.floor(Math.random() * SNACK_EMOJIS.length)],
          x: 10 + Math.random() * 80,
          born: now,
        },
      ])
    }, SPAWN_MS)

    // 約15回/秒 口を調べる
    const detectTimer = setInterval(() => {
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.videoWidth === 0) return

      let face
      try {
        face = landmarker.detect(video).faceLandmarks[0]
      } catch (err) {
        console.error('顔検出エラー:', err)
        return
      }
      if (!face) {
        setMouth(null)
        return
      }

      // ランドマーク番号: 13=上唇の内側, 14=下唇の内側, 10=おでこ, 152=あご
      const W = video.videoWidth
      const H = video.videoHeight
      const upper = { x: face[13].x * W, y: face[13].y * H }
      const lower = { x: face[14].x * W, y: face[14].y * H }
      const faceHeight = Math.hypot(
        (face[152].x - face[10].x) * W,
        (face[152].y - face[10].y) * H
      )
      const gap = Math.hypot(lower.x - upper.x, lower.y - upper.y)
      const open = gap / faceHeight > MOUTH_OPEN_RATIO
      const mx = (upper.x + lower.x) / 2
      const my = (upper.y + lower.y) / 2
      const radius = faceHeight * CATCH_RADIUS

      setMouth({ x: (mx / W) * 100, y: (my / H) * 100, r: (radius / W) * 100, open })
      if (!open) return

      const now = Date.now()
      const caught = snacksRef.current.filter((s) => {
        const sx = (s.x / 100) * W
        const sy = (snackY(s.born, now) / 100) * H
        return Math.hypot(sx - mx, sy - my) < radius
      })
      if (caught.length === 0) return

      updateSnacks(snacksRef.current.filter((s) => !caught.includes(s)))
      total += caught.length
      setScore(total)
      onSnackCount(peerId, stream.id, total)
      // 食べた場所に「+1」を浮かべる（floatUp アニメーションを再利用）
      setPops((prev) => [
        ...prev.filter((p) => now - p.id < 1000),
        ...caught.map((s, i) => ({ id: now + i / 100, x: s.x, y: snackY(s.born, now) })),
      ])
    }, 66)

    // スマホが切断されてVideoPanelが消えたらタイマーを止める
    return () => {
      clearInterval(spawnTimer)
      clearInterval(detectTimer)
    }
  }, [landmarker, stream, peerId, onSnackCount])

  return (
    <div className="relative overflow-hidden rounded [container-type:inline-size]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="block w-full rounded bg-black"
      />

      {snacks.map((snack) => (
        <span
          key={snack.id}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 animate-[snackRise_4s_linear_forwards] text-[8cqw]"
          style={{ left: `${snack.x}%` }}
        >
          {snack.emoji}
        </span>
      ))}

      {mouth && (
        <div
          className={`pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
            mouth.open ? 'border-green-400 bg-green-400/20' : 'border-white/60'
          }`}
          style={{ left: `${mouth.x}%`, top: `${mouth.y}%`, width: `${mouth.r * 2}%` }}
        />
      )}

      {pops.map((pop) => (
        <span
          key={pop.id}
          className="pointer-events-none absolute animate-[floatUp_1s_ease-out_forwards] text-[5cqw] font-black text-yellow-300"
          style={{ left: `${pop.x}%`, bottom: `${100 - pop.y}%` }}
        >
          +1
        </span>
      ))}

      {landmarker && (
        <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 text-sm font-bold text-white">
          🍪 ×{score}
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
  const [landmarker, setLandmarker] = useState<FaceLandmarker | null>(null)
  const [landmarkerError, setLandmarkerError] = useState<string | null>(null)
  // key: stream.id, value: 食べたお菓子の数
  const [snackCounts, setSnackCounts] = useState<Record<string, number>>({})
  // key: スマホのpeer ID（数をスマホへ送り返すため）
  const connectionsRef = useRef(new Map<string, DataConnection>())

  const smartphoneUrl = `${window.location.origin}${import.meta.env.BASE_URL}?host=${peerId}`

  const totalSnacks = videos.reduce(
    (sum, video) => sum + (snackCounts[video.stream.id] ?? 0),
    0
  )

  const handleSnackCount = useCallback(
    (phonePeerId: string, streamId: string, count: number) => {
      setSnackCounts((prev) => ({ ...prev, [streamId]: count }))
      const conn = connectionsRef.current.get(phonePeerId)
      if (conn && conn.open) {
        conn.send({ snacks: count })
      }
    },
    []
  )

  useEffect(() => {
    let active = true
    loadFaceLandmarker()
      .then((loaded) => {
        if (active) setLandmarker(loaded)
      })
      .catch((err) => {
        console.error('顔検出モデルの読み込みに失敗しました', err)
        if (active) setLandmarkerError(err instanceof Error ? err.message : String(err))
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
      {!landmarker && !landmarkerError && (
        <p className="mt-4 text-sm text-gray-600">Loading face model...</p>
      )}
      {landmarkerError && (
        <p className="mt-4 text-sm text-red-600">
          Snack game is not available (face model failed to load): {landmarkerError}
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
            Total snacks: {totalSnacks}
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
            landmarker={landmarker}
            onSnackCount={handleSnackCount}
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

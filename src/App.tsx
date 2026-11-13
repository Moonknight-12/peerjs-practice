import { useEffect, useRef, useState } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import { QRCodeSVG } from 'qrcode.react'

function Smartphone({ hostId }: { hostId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DataConnection | null>(null)
  const [cameraSettings, setCameraSettings] = useState<MediaTrackSettings | null>(null)
  const [message, setMessage] = useState('ドン！')

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
  stream,
  effects,
}: {
  stream: MediaStream
  effects: {
    id: number
    peerId: string
    text: string
    x: number
    y: number
  }[]
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch((err) => console.error('再生エラー:', err))
    }
  }, [stream])

  return (
    <div className="relative [container-type:inline-size]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full rounded bg-black"
      />

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
  const [videos, setVideos] =
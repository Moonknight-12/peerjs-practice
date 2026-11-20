// メガネ検出用の Web Worker
// OWL-ViT（文字で探す物を指定できるモデル）は重いので、画面が固まらないよう別スレッドで動かす
import {
  pipeline,
  RawImage,
  type ZeroShotObjectDetectionPipeline,
} from '@huggingface/transformers'

type Request = { type: 'detect'; id: number; bitmap: ImageBitmap }

const THRESHOLD = 0.1 // OWL-ViT のスコアは低めに出るので 0.1 を基準にする

let detector: ZeroShotObjectDetectionPipeline | null = null
let queue: Promise<void> = Promise.resolve()

pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32', {
  device: 'wasm',
  dtype: 'q8', // 約155MB（初回だけダウンロード、以降はブラウザのキャッシュ）
})
  .then((loaded) => {
    detector = loaded
    self.postMessage({ type: 'ready' })
  })
  .catch((err) => {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  })

async function detect({ id, bitmap }: Request) {
  try {
    if (!detector) throw new Error('model is not ready')
    const { width, height } = bitmap
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()

    const results = await detector(RawImage.fromCanvas(canvas), ['eyeglasses'], {
      threshold: THRESHOLD,
    })
    // 位置は画像の幅・高さに対する % にして返す
    const boxes = results.map((r) => ({
      x: (r.box.xmin / width) * 100,
      y: (r.box.ymin / height) * 100,
      w: ((r.box.xmax - r.box.xmin) / width) * 100,
      h: ((r.box.ymax - r.box.ymin) / height) * 100,
      score: r.score,
    }))
    self.postMessage({ type: 'result', id, boxes })
  } catch (err) {
    self.postMessage({
      type: 'result',
      id,
      boxes: [],
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

self.onmessage = (e: MessageEvent<Request>) => {
  // 複数のスマホから同時に頼まれても、1つずつ順番に処理する
  queue = queue.then(() => detect(e.data))
}

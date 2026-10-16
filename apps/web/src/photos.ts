// Photos of cookbook pages, made small enough to send (TYL-52): about 1,600 px
// on the long side is plenty to read print, and keeps four pages well under
// the API's upload limit.

const LONG_SIDE = 1600

/** A photo as base64 JPEG, shrunk to LONG_SIDE and turned upright (phones
 *  keep the camera's rotation in the file). */
export async function shrinkPhoto(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  })
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error("This browser can't prepare photos.")
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const url = canvas.toDataURL('image/jpeg', 0.85)
  return url.slice(url.indexOf(',') + 1)
}

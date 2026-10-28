import pica from 'pica';
import { decode, encode } from 'fast-png';
import type { Task } from './types';

const resizer = pica({ features: ['wasm', 'js'] });

export async function prepareEnhanceImage(task: Task): Promise<string> {
  const source = decode(Uint8Array.from(atob(task.parameters.image!), char => char.charCodeAt(0)));
  // The Enhance importer retains RGB/RGBA PNGs and converts other input formats.
  if (source.depth !== 8 || ![3, 4].includes(source.channels)) throw new Error('增强图片编码不受支持，请重新选择图片');
  const pixels = new Uint8ClampedArray(source.width * source.height * 4);
  if (source.channels === 4) pixels.set(source.data);
  else for (let from = 0, to = 0; from < source.data.length; from += 3, to += 4) {
    pixels.set(source.data.subarray(from, from + 3), to); pixels[to + 3] = 255;
  }
  const signature = 'stealth_pngcomp';
  const count = source.width * source.height;
  if (count >= signature.length * 8 && count <= 0x1000000) {
    const matches = [...signature].every((char, index) => {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const position = index * 8 + bit;
        byte = byte * 2 + (pixels[4 * ((position % source.height) * source.width + Math.floor(position / source.height)) + 3] & 1);
      }
      return byte === char.charCodeAt(0);
    });
    if (matches) for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] === 254) pixels[i] = 255;
      else if (pixels[i] === 1) pixels[i] = 0;
    }
  }
  const {width, height} = task.parameters;
  const result = source.width === width && source.height === height ? pixels
    : new Uint8ClampedArray(await resizer.resizeBuffer({src: pixels, width: source.width, height: source.height,
      toWidth: width, toHeight: height, filter: 'lanczos3'}));
  if (!task.model.startsWith('nai-diffusion-5')) for (let i = 0; i < result.length; i += 4) {
    const alpha = result[i + 3] / 255;
    for (let channel = 0; channel < 3; channel++) result[i + channel] = result[i + channel] * alpha + 255 * (1 - alpha);
    result[i + 3] = 255;
  }
  const encoded = encode({width, height, data: result, channels: 4});
  let binary = '';
  for (let i = 0; i < encoded.length; i += 32768) binary += String.fromCharCode(...encoded.subarray(i, i + 32768));
  return btoa(binary);
}

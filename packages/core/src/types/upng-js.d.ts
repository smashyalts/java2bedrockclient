declare module "upng-js" {
  /** cnum 0 = lossless (filters + deflate); >0 = lossy palette quantization. */
  export function encode(
    frames: ArrayBuffer[],
    width: number,
    height: number,
    cnum: number,
    delays?: number[],
  ): ArrayBuffer;
  const UPNG: { encode: typeof encode };
  export default UPNG;
}

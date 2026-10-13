/**
 * OCR, as the capture layer sees it: an image in, text out, stamped.
 *
 * The text that comes back is not a copy of the image; it is a model's
 * reading of it. So it enters as a chunk with the provenance of wherever the
 * image came from and `via: "ocr"`, which is what lets a later reader tell
 * "the page said this" from "something read this off a picture of the page".
 *
 *   POST <url>
 *   { image: <base64>, mimeType }
 *   -> { text, model }
 *
 * When the OCR cannot be reached nothing enters. That is the safe direction:
 * the model reads less, and the capture records that it did.
 */
import { z } from "zod";
import { postJson, type HttpOptions } from "../adapters/http.js";

export const ocrReadingSchema = z.object({
  text: z.string(),
  model: z.string().min(1),
});
export type OcrReading = z.infer<typeof ocrReadingSchema>;

export type OcrResult =
  | { readonly ok: true; readonly reading: OcrReading }
  | { readonly ok: false; readonly reason: string };

export interface Ocr {
  readonly name: string;
  read(image: Uint8Array, mimeType: string): Promise<OcrResult>;
}

export class HttpOcr implements Ocr {
  readonly name: string;

  constructor(
    private readonly options: HttpOptions & { readonly name?: string },
  ) {
    this.name = options.name ?? "http";
  }

  async read(image: Uint8Array, mimeType: string): Promise<OcrResult> {
    const result = await postJson(
      this.options,
      { image: Buffer.from(image).toString("base64"), mimeType },
      ocrReadingSchema,
    );
    return result.ok
      ? { ok: true, reading: result.value }
      : { ok: false, reason: result.reason };
  }
}

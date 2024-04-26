import { ImageData, ImageSource } from "../typing";
import { ImageBase } from "./base";
import * as http from "http";
import * as https from "https";
import configure from "@jimp/custom";
import types from "@jimp/types";
import resize from "@jimp/plugin-resize";

const Jimp = configure({
  types: [types],
  plugins: [resize],
});

interface ProtocolHandlerMap {
  [protocolName: string]: ProtocolHandler;
}

const URL_REGEX: RegExp = /^(\w+):\/\/.*/i;

const PROTOCOL_HANDLERS: ProtocolHandlerMap = {
  http,
  https,
} as const;
type ProtocolHandler = typeof http | typeof https;

type NodeImageSource = string | Buffer;

const REDIRECT_HTTP_CODES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const MAX_REDIRECTS = 5;

function processGetRequest({
  handler,
  src,
  followedRedirects = 0,
  resolve,
  reject,
}: {
  handler?: ProtocolHandler;
  src: string;
  followedRedirects?: number;
  resolve: (buf: Buffer) => void;
  reject: (err: any) => void;
}) {
  let buf = Buffer.alloc(0);

  try {
    if (!handler) {
      handler = getHandlerForUrlProtocol(src);
    }
  } catch (error) {
    reject(error);
    return;
  }

  handler
    .get(src, (resp) => {
      // Handle redirects
      if (
        resp.statusCode &&
        REDIRECT_HTTP_CODES.has(resp.statusCode) &&
        resp.headers.location &&
        followedRedirects < MAX_REDIRECTS
      ) {
        const redirectUrl = resp.headers.location;
        try {
          // Get the handler for the redirect URL, if it has changed. For
          // example if we were redirected from http to https.
          handler = getHandlerForUrlProtocol(redirectUrl);
        } catch (error) {
          reject(error);
          return;
        }
        processGetRequest({
          handler,
          src: redirectUrl,
          followedRedirects: followedRedirects + 1,
          resolve,
          reject,
        });
        // Don't try to read data from the response, as it will be empty
        return;
      }
      resp.on("data", (data: any) => {
        buf = Buffer.concat([buf, data]);
      });
      resp.on("end", () => resolve(buf));
      resp.on("error", reject);
    })
    .on("error", reject);
}

function getHandlerForUrlProtocol(url: string) {
  const m = URL_REGEX.exec(url);
  let protocol = m?.[1].toLocaleLowerCase();
  if (!protocol || !PROTOCOL_HANDLERS[protocol]) {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }
  return PROTOCOL_HANDLERS[protocol];
}

export default class NodeImage extends ImageBase {
  private _image: InstanceType<typeof Jimp>;
  private _loadByProtocolHandler({
    handler,
    src,
  }: {
    handler?: ProtocolHandler;
    src: string;
  }): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      processGetRequest({
        handler,
        src: src,
        resolve,
        reject,
      });
    });
  }

  private _loadFromPath(src: string): Promise<ImageBase> {
    let m = URL_REGEX.exec(src);
    if (m) {
      return this._loadByProtocolHandler({ src }).then((buf) =>
        this._loadByJimp(buf),
      );
    } else {
      return this._loadByJimp(src);
    }
  }
  private _loadByJimp(src: NodeImageSource): Promise<ImageBase> {
    // NOTE: TypeScript doesn't support union type to overloads yet
    //       Use type assertion to bypass compiler error
    return Jimp.read(<string>src).then((result) => {
      this._image = result;
      return this;
    });
  }
  load(image: ImageSource): Promise<ImageBase> {
    if (typeof image === "string") {
      return this._loadFromPath(image);
    } else if (image instanceof Buffer) {
      return this._loadByJimp(image);
    } else {
      return Promise.reject(
        new Error(
          "Cannot load image from HTMLImageElement in node environment",
        ),
      );
    }
  }
  clear(): void {}
  update(imageData: ImageData): void {}
  getWidth(): number {
    return this._image.bitmap.width;
  }
  getHeight(): number {
    return this._image.bitmap.height;
  }
  resize(targetWidth: number, targetHeight: number, ratio: number): void {
    this._image.resize(targetWidth, targetHeight);
  }
  getPixelCount(): number {
    let bitmap = this._image.bitmap;
    return bitmap.width * bitmap.height;
  }
  getImageData(): ImageData {
    return this._image.bitmap;
  }
  remove(): void {}
}

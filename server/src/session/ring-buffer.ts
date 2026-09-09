/**
 * Fixed-capacity circular byte buffer for PTY scrollback.
 *
 * Backed by a single preallocated Buffer: `push` only ever copies bytes, it
 * never allocates or grows. Once capacity is exceeded the oldest bytes are
 * silently dropped, so the buffer always holds the newest `capacity` bytes.
 */
export class RingBuffer {
  readonly #capacity: number;
  readonly #buf: Buffer;

  /** Index where the next byte will be written. */
  #cursor = 0;
  /** Bytes currently held; saturates at capacity. */
  #length = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`RingBuffer capacity must be a non-negative integer, got ${capacity}`);
    }
    this.#capacity = capacity;
    this.#buf = Buffer.allocUnsafe(capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get length(): number {
    return this.#length;
  }

  push(chunk: Buffer): void {
    if (this.#capacity === 0 || chunk.length === 0) return;

    // A chunk larger than capacity: only its trailing `capacity` bytes survive,
    // and they fill the buffer exactly, so reset the cursor to the origin.
    if (chunk.length >= this.#capacity) {
      chunk.copy(this.#buf, 0, chunk.length - this.#capacity);
      this.#cursor = 0;
      this.#length = this.#capacity;
      return;
    }

    const untilEnd = this.#capacity - this.#cursor;
    if (chunk.length <= untilEnd) {
      chunk.copy(this.#buf, this.#cursor);
    } else {
      chunk.copy(this.#buf, this.#cursor, 0, untilEnd);
      chunk.copy(this.#buf, 0, untilEnd);
    }

    this.#cursor = (this.#cursor + chunk.length) % this.#capacity;
    this.#length = Math.min(this.#length + chunk.length, this.#capacity);
  }

  /** Returns a fresh copy of the contents, ordered oldest -> newest. */
  read(): Buffer {
    if (this.#length === 0) return Buffer.alloc(0);

    const start = (this.#cursor - this.#length + this.#capacity) % this.#capacity;
    const out = Buffer.allocUnsafe(this.#length);

    const untilEnd = this.#capacity - start;
    if (this.#length <= untilEnd) {
      this.#buf.copy(out, 0, start, start + this.#length);
    } else {
      this.#buf.copy(out, 0, start, this.#capacity);
      this.#buf.copy(out, untilEnd, 0, this.#length - untilEnd);
    }

    return out;
  }

  clear(): void {
    this.#cursor = 0;
    this.#length = 0;
  }
}

/**
 * Timestamped output log for asciicast v2 export.
 *
 * Kept beside the ring buffer rather than replacing it: replay needs raw bytes
 * fast, export needs timing. Capped by bytes like the ring buffer, dropping the
 * oldest events, so a long session costs a bounded amount of memory.
 */
export type CastEvent = [seconds: number, kind: 'o' | 'r', data: string];

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  title?: string;
}

export class CastRecorder {
  readonly #capacity: number;
  readonly #events: CastEvent[] = [];
  #bytes = 0;
  #startedAt: number;
  #cols: number;
  #rows: number;
  /** Geometry at the first retained event, which is what the header describes. */
  #headerCols: number;
  #headerRows: number;
  readonly #now: () => number;

  constructor(capacityBytes: number, cols: number, rows: number, now: () => number = Date.now) {
    this.#capacity = capacityBytes;
    this.#cols = cols;
    this.#rows = rows;
    this.#headerCols = cols;
    this.#headerRows = rows;
    this.#now = now;
    this.#startedAt = now();
  }

  output(data: string): void {
    this.#push([this.#elapsed(), 'o', data]);
  }

  resize(cols: number, rows: number): void {
    this.#cols = cols;
    this.#rows = rows;
    this.#push([this.#elapsed(), 'r', `${cols}x${rows}`]);
  }

  /** A restart is a new recording. */
  clear(): void {
    this.#events.length = 0;
    this.#bytes = 0;
    this.#startedAt = this.#now();
    this.#headerCols = this.#cols;
    this.#headerRows = this.#rows;
  }

  /** The recording as an asciicast v2 document (newline-delimited JSON). */
  toCast(title?: string): string {
    const header: CastHeader = {
      version: 2,
      width: this.#headerCols,
      height: this.#headerRows,
      timestamp: Math.floor(this.#startedAt / 1000),
      ...(title ? { title } : {}),
    };
    return [JSON.stringify(header), ...this.#events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }

  get eventCount(): number {
    return this.#events.length;
  }

  #elapsed(): number {
    return Math.round(this.#now() - this.#startedAt) / 1000;
  }

  #push(event: CastEvent): void {
    this.#events.push(event);
    this.#bytes += event[2].length;
    while (this.#bytes > this.#capacity && this.#events.length > 1) {
      const dropped = this.#events.shift()!;
      this.#bytes -= dropped[2].length;
      // Output after a dropped resize was drawn at the resized geometry.
      if (dropped[1] === 'r') {
        const [cols, rows] = dropped[2].split('x').map(Number);
        this.#headerCols = cols ?? this.#headerCols;
        this.#headerRows = rows ?? this.#headerRows;
      }
    }
  }
}

import { EventTarget } from 'event-target-shim';
import * as GCS from './UpChunk/strategies/GCS';

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type EventName =
  | 'attempt'
  | 'attemptFailure'
  | 'chunkUploaded'
  | 'error'
  | 'offline'
  | 'online'
  | 'progress'
  | 'success'
  | 'pause'
  | 'resume';

type IEndpoint = string | ((file?: File) => Promise<string>);

export interface IUploadResponse {
  response: Response;
  success: boolean;
  uploadComplete: boolean;
  index: number;
  chunk: Blob;
  headers: Headers;
}
export interface IUpload {
  (
    endpoint: string,
    chunkDetails: IChunkDetails,
    chunk: Blob,
    file: File,
    headers: Headers
  ): Promise<IUploadResponse>;
}

interface IOptions {
  endpoint: IEndpoint;
  file: File;
  headers?: Headers;
  chunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
  upload?: IUpload;
  maxParallelRequests?: number;
  strategy?: Partial<IOptions>;
}

export interface IChunkDetails {
  index: number;
  attempting: boolean;
  start: number;
  end: number;
  size: number;
  uploaded: boolean;
  attempts: number;
  timing?: number;
  blob?: Blob;
}

export class UpChunk implements IOptions {
  public endpoint: IEndpoint;
  public file: File;
  public headers: Headers;
  public chunkSize: number;
  public attempts: number;
  public delayBeforeAttempt: number;
  public upload: IUpload;
  public maxParallelRequests: number;
  public strategy: Partial<IOptions>;

  private chunkCount: number;
  private chunkByteSize: number;
  private endpointValue: string;
  private totalChunks: number;
  private attemptCount: number;
  private offline: boolean;
  private paused: boolean;
  private chunkDetails: IChunkDetails[];

  private reader: FileReader;
  private eventTarget: EventTarget;

  constructor(userOptions: IOptions) {
    this.endpoint = userOptions.endpoint;
    this.file = userOptions.file;
    this.strategy = userOptions.strategy || GCS.resumable;
    const options = { ...this.strategy, userOptions };

    this.headers = options.headers || ({} as Headers);
    this.chunkSize = options.chunkSize || 5120;
    this.attempts = options.attempts || 5;
    this.delayBeforeAttempt = options.delayBeforeAttempt || 1;
    this.upload = options.upload || GCS.resumable.upload;
    this.maxParallelRequests = options.maxParallelRequests || 3;

    this.chunkCount = 0;
    this.chunkByteSize = this.chunkSize * 1024;
    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);
    this.attemptCount = 0;
    this.offline = false;
    this.paused = false;
    this.chunkDetails = [];

    this.reader = new FileReader();
    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.getEndpoint()
      .then(() => this.buildChunkArray())
      .then(() => this.sendChunks(this.maxParallelRequests));

    // restart sync when back online
    // trigger events when offline/back online
    window.addEventListener('online', () => {
      if (!this.offline) {
        return;
      }

      this.offline = false;
      this.dispatch('online');
      this.sendChunks(this.maxParallelRequests);
    });

    window.addEventListener('offline', () => {
      this.offline = true;
      this.dispatch('offline');
    });
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: Event) => void) {
    this.eventTarget.addEventListener(eventName, fn);
  }

  public done() {
    this;
  }

  public pause() {
    if (this.paused) return;

    this.paused = true;
    this.dispatch('pause');
  }

  public resume() {
    if (!this.paused) return;
    this.paused = false;
    this.dispatch('resume');

    this.sendChunks(this.maxParallelRequests);
  }

  private buildChunkArray() {
    for (let i = 0; i < this.totalChunks; i = i + 1) {
      const start = i * this.chunkByteSize;
      // for the last chunk we just need to have it be the remainder of the file.
      const size =
        i + 1 === this.totalChunks
          ? this.file.size - this.chunkByteSize * i
          : this.chunkByteSize;
      this.chunkDetails = [
        ...this.chunkDetails,
        {
          start,
          size,
          end: start + size,
          index: i,
          uploaded: false,
          attempts: 0,
          attempting: false,
        },
      ];
    }
  }

  /**
   * Dispatch an event
   */
  private dispatch(eventName: EventName, detail?: any) {
    const event = new CustomEvent(eventName, { detail });

    this.eventTarget.dispatchEvent(event);
  }

  /**
   * Validate options and throw error if not of the right type
   */
  private validateOptions() {
    if (
      !this.endpoint ||
      (typeof this.endpoint !== 'function' && typeof this.endpoint !== 'string')
    ) {
      throw new TypeError(
        'endpoint must be defined as a string or a function that returns a promise'
      );
    }
    if (!(this.file instanceof File)) {
      throw new TypeError('file must be a File object');
    }
    if (this.headers && typeof this.headers !== 'object') {
      throw new TypeError('headers must be null or an object');
    }
    if (
      this.chunkSize &&
      (typeof this.chunkSize !== 'number' ||
        this.chunkSize <= 0 ||
        this.chunkSize % 256 !== 0)
    ) {
      throw new TypeError(
        'chunkSize must be a positive number in multiples of 256'
      );
    }
    if (
      this.attempts &&
      (typeof this.attempts !== 'number' || this.attempts <= 0)
    ) {
      throw new TypeError('retries must be a positive number');
    }
    if (
      this.delayBeforeAttempt &&
      (typeof this.delayBeforeAttempt !== 'number' ||
        this.delayBeforeAttempt < 0)
    ) {
      throw new TypeError('delayBeforeAttempt must be a positive number');
    }
    if (
      typeof this.maxParallelRequests !== 'number' ||
      this.maxParallelRequests < 0
    ) {
      throw new TypeError('maxParallelRequests must be a positive number');
    }
  }

  /**
   * Endpoint can either be a URL or a function that returns a promise that resolves to a string.
   */
  private getEndpoint() {
    if (typeof this.endpoint === 'string') {
      this.endpointValue = this.endpoint;
      return Promise.resolve(this.endpoint);
    }

    return this.endpoint(this.file).then(value => {
      this.endpointValue = value;
      return this.endpointValue;
    });
  }

  private updateChunkDetails(index: number, update: Partial<IChunkDetails>) {
    this.chunkDetails[index] = { ...this.chunkDetails[index], ...update };

    return this.chunkDetails[index];
  }

  /**
   * Get portion of the file of x bytes corresponding to chunkSize
   */
  private getChunk(): Promise<IChunkDetails> {
    return new Promise((resolve, reject) => {
      const nextChunkIndex = this.chunkDetails.findIndex(
        chunk => !chunk.uploaded && !chunk.attempting
      );

      if (nextChunkIndex < 0) {
        if (this.chunkDetails.findIndex(chunk => chunk.attempting) >= 0) {
          return reject('no_chunks_available');
        }

        return reject('no_chunks');
      }

      let nextChunk = this.updateChunkDetails(nextChunkIndex, {
        attempting: true,
      });

      this.reader.onload = () => {
        if (this.reader.result !== null) {
          const blob = new Blob([this.reader.result], {
            type: 'application/octet-stream',
          });

          nextChunk = { ...nextChunk, blob };
        }
        resolve(nextChunk);
      };

      this.reader.readAsArrayBuffer(
        this.file.slice(nextChunk.start, nextChunk.end)
      );
    });
  }

  /**
   * Send chunk of the file with appropriate headers and add post parameters if it's last chunk
   */
  private async sendChunk(chunkDetails: IChunkDetails) {
    // Improve this error or figure out why it's needing to be guarded here.
    if (!chunkDetails.blob) throw Error();

    this.dispatch('attempt', chunkDetails);

    const attemptDetails = await this.upload(
      this.endpointValue,
      chunkDetails,
      chunkDetails.blob,
      this.file,
      this.headers
    );

    this.dispatch('chunkUploaded', attemptDetails);

    return attemptDetails;
  }

  /**
   * Called on net failure. If retry counter !== 0, retry after delayBeforeAttempt
   */
  private manageRetries() {
    if (this.attemptCount < this.attempts) {
      this.attemptCount = this.attemptCount + 1;
      setTimeout(() => this.sendChunks(1), this.delayBeforeAttempt * 1000);
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${this
          .attempts - this.attemptCount} retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
      });
      return;
    }

    this.dispatch('error', {
      message: `An error occured uploading chunk ${
        this.chunkCount
      }. No more retries, stopping upload`,
      chunk: this.chunkCount,
      attempts: this.attemptCount,
    });
  }

  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private async sendChunks(count: number) {
    let chunkArray: IChunkDetails[] = [];
    for (let i = 0; i < count; i = i + 1) {
      const chunk = await this.getChunk();
      chunkArray = [...chunkArray, chunk];
    }

    return chunkArray.map(chunk => this.chunkSender(chunk));
  }

  private chunkSender(chunk: IChunkDetails) {
    if (!chunk.blob || this.paused || this.offline) {
      return;
    }

    this.sendChunk(chunk)
      .then(attemptDetails => {
        if (attemptDetails.uploadComplete) {
          return this.dispatch('success');
        }

        this.chunkCount = this.chunkCount + 1;

        this.sendChunks(1);
        const percentProgress = Math.round(
          (100 / this.totalChunks) * attemptDetails.index
        );

        this.dispatch('progress', percentProgress);
      })
      .catch(err => {
        if (err === 'no_chunks' || this.paused || this.offline) {
          return;
        }

        if (err.details && !err.details.shouldRetry) {
          this.dispatch('error', {
            ...err.details,
            message: `Server responded with an unrecoverable error. Stopping upload.`,
          });

          return;
        }

        // this type of error can happen after network disconnection on CORS setup
        this.manageRetries();
      });
  }
}

export const createUpload = (options: IOptions) => new UpChunk(options);

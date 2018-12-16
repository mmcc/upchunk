import { IUploadResponse } from '../upchunk';

interface IUploadErrorDetails extends IUploadResponse {
  shouldRetry: boolean;
}

class UploadError extends Error {
  public details: IUploadResponse;

  constructor(
    details: IUploadErrorDetails,
    message = `Error uploading chunk ${details.index}`
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);

    this.details = details;
  }
}

export default UploadError;

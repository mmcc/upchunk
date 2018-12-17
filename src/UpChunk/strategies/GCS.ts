import { IChunkDetails, IUploadResponse } from '../../upchunk';
import UploadError from '../UploadError';

const CHUNK_SUCCESS_CODES = [308];
const FILE_SUCCESS_CODES = [200, 201];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504];

export const resumable = {
  chunkSize: 5120,
  maxParralelRequests: 1,
  upload(
    endpoint: string,
    chunkDetails: IChunkDetails,
    chunk: Blob,
    file: File,
    headers: Headers
  ): Promise<IUploadResponse> {
    const extendedHeaders = {
      ...headers,
      'Content-Type': file.type,
      'Content-Length': chunk.size,
      'Content-Range': `bytes ${chunkDetails.start}-${chunkDetails.end - 1}/${
        file.size
      }`,
    };

    return fetch(endpoint, {
      headers: extendedHeaders,
      method: 'PUT',
      body: chunk,
    }).then(response => {
      const attemptDetails = {
        chunk,
        response,
        index: chunkDetails.index,
        success: false,
        uploadComplete: false,
        headers: extendedHeaders,
      };

      if (CHUNK_SUCCESS_CODES.includes(response.status)) {
        attemptDetails.success = true;
        attemptDetails.uploadComplete = false;
      } else if (FILE_SUCCESS_CODES.includes(response.status)) {
        attemptDetails.success = true;
        attemptDetails.uploadComplete = true;
      } else {
        const shouldRetry = TEMPORARY_ERROR_CODES.includes(response.status);

        throw new UploadError({ ...attemptDetails, shouldRetry });
      }

      return attemptDetails;
    });
  },
};

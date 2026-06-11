import { describe, it, expect, afterEach } from 'vitest';
import { constructStorageProvider } from '../src/bundle-fetcher.js';

afterEach(() => {
  delete process.env.PANGOLIN_S3_ENDPOINT;
});

describe('constructStorageProvider S3 endpoint passthrough', () => {
  it('passes the endpoint through to S3StorageProvider when PANGOLIN_S3_ENDPOINT is set', async () => {
    process.env.PANGOLIN_S3_ENDPOINT = 'http://host.docker.internal:9000';
    const sp: any = await constructStorageProvider('s3://pangolin-data');
    const cfgEndpoint = await sp.s3.config.endpoint();
    expect(cfgEndpoint.hostname).toBe('host.docker.internal');
  });

  it('uses the default client when PANGOLIN_S3_ENDPOINT is unset', async () => {
    const sp: any = await constructStorageProvider('s3://pangolin-data');
    // When no custom endpoint is configured, the AWS SDK does not expose
    // a fixed `config.endpoint` function (it uses its own endpoint-provider
    // chain instead). Either it is undefined, or it resolves to a non-MinIO host.
    const endpointFn: unknown = sp.s3.config.endpoint;
    if (typeof endpointFn === 'function') {
      const cfgEndpoint = await (endpointFn as () => Promise<{ hostname: string }>)();
      expect(cfgEndpoint.hostname).not.toBe('host.docker.internal');
    } else {
      // config.endpoint is undefined — default AWS endpoint resolution is active,
      // which by definition does not point to host.docker.internal.
      expect(endpointFn).toBeUndefined();
    }
  });
});

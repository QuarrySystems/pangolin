import { describe, it, expect } from 'vitest';
import { LocalDockerProvider } from '../src/index.js';

it('passes extraEnv into the container Env (spec.env wins on collision)', async () => {
  const captured: any = {};
  const fakeDocker: any = {
    createContainer: async (cfg: any) => { captured.cfg = cfg; return { id: 'x', start: async () => {} }; },
  };
  const p = new LocalDockerProvider({
    docker: fakeDocker,
    allowUnpinnedImage: true,
    extraEnv: { PANGOLIN_S3_ENDPOINT: 'http://host.docker.internal:9000', PANGOLIN_NAMESPACE: 'from-extra' },
  });
  await p.run(
    { image: 'img:tag', command: [], dispatchId: 'd', env: { PANGOLIN_NAMESPACE: 'from-spec' }, secretRefs: {} } as any,
    {} as any,
  );
  expect(captured.cfg.Env).toContain('PANGOLIN_S3_ENDPOINT=http://host.docker.internal:9000');
  expect(captured.cfg.Env).toContain('PANGOLIN_NAMESPACE=from-spec'); // spec.env wins
});

describe('LocalDockerProvider — extraEnv option', () => {
  it('defaults to no extra env when extraEnv is not provided', async () => {
    const captured: any = {};
    const fakeDocker: any = {
      createContainer: async (cfg: any) => { captured.cfg = cfg; return { id: 'y', start: async () => {} }; },
    };
    const p = new LocalDockerProvider({
      docker: fakeDocker,
      allowUnpinnedImage: true,
    });
    await p.run(
      { image: 'img:tag', command: [], dispatchId: 'd2', env: { MY_KEY: 'my-val' }, secretRefs: {} } as any,
      {} as any,
    );
    expect(captured.cfg.Env).toContain('MY_KEY=my-val');
    expect(captured.cfg.Env).toHaveLength(1);
  });

  it('merges multiple extraEnv keys into the container Env', async () => {
    const captured: any = {};
    const fakeDocker: any = {
      createContainer: async (cfg: any) => { captured.cfg = cfg; return { id: 'z', start: async () => {} }; },
    };
    const p = new LocalDockerProvider({
      docker: fakeDocker,
      allowUnpinnedImage: true,
      extraEnv: {
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
        PANGOLIN_S3_ENDPOINT: 'http://minio:9000',
      },
    });
    await p.run(
      { image: 'img:tag', command: [], dispatchId: 'd3', env: {}, secretRefs: {} } as any,
      {} as any,
    );
    expect(captured.cfg.Env).toContain('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(captured.cfg.Env).toContain('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI');
    expect(captured.cfg.Env).toContain('PANGOLIN_S3_ENDPOINT=http://minio:9000');
  });
});

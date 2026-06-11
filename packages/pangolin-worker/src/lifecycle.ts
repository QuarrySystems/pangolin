import { createHmac } from 'node:crypto';
import type { LifecycleEvent } from '@quarry-systems/pangolin-core';

export class LifecycleEmitter {
  constructor(private readonly opts: {
    callbackUrl?: string;
    hmacKey?: string;
    fetchImpl?: typeof fetch;
  }) {}

  async emit(event: LifecycleEvent): Promise<void> {
    if (!this.opts.callbackUrl || !this.opts.hmacKey) return;

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify(event);
    const signature = createHmac('sha256', this.opts.hmacKey)
      .update(`${event.dispatchId}.${timestamp}.${payload}`)
      .digest('hex');

    await fetchFn(this.opts.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pangolin Scale-Signature': `sha256=${signature}`,
        'X-Pangolin Scale-Dispatch-Id': event.dispatchId,
        'X-Pangolin Scale-Timestamp': timestamp,
      },
      body: payload,
    });
  }
}

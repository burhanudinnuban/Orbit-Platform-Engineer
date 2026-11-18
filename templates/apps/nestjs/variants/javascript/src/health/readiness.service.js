import { Injectable } from '@nestjs/common';

/** Whether the pod should receive traffic; false once shutdown has begun. */
@Injectable()
export class ReadinessService {
  ready = true;
}

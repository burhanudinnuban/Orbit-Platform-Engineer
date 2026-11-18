import { Injectable } from '@nestjs/common';

export interface ServiceInfo {
  service: string;
  status: 'ok';
  environment: string;
}

@Injectable()
export class AppService {
  getInfo(): ServiceInfo {
    return {
      service: process.env.ORBIT_APP || '{{APP_NAME}}',
      status: 'ok',
      environment: process.env.ORBIT_ENV ?? 'local',
    };
  }
}

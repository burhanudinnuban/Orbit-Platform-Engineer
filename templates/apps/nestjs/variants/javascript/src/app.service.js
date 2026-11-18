import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      service: process.env.ORBIT_APP || '{{APP_NAME}}',
      status: 'ok',
      environment: process.env.ORBIT_ENV ?? 'local',
    };
  }
}

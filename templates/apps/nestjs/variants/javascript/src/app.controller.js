import { Controller, Dependencies, Get } from '@nestjs/common';
import { AppService } from './app.service';

// JavaScript has no type metadata, so @Dependencies() tells Nest what to inject.
@Controller()
@Dependencies(AppService)
export class AppController {
  constructor(appService) {
    this.appService = appService;
  }

  @Get()
  getInfo() {
    return this.appService.getInfo();
  }
}

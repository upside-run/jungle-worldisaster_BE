import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Video } from './video.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideoRepository } from './video.repository';
@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  controllers: [UploadController],
  providers: [
    UploadService, VideoRepository
  ],
  exports: [VideoRepository]
})
export class UploadModule {}
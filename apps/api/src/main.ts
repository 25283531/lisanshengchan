import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
async function bootstrap() { const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api'); app.enableCors({ origin: process.env.WEB_ORIGIN?.split(',') ?? true }); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); const config = new DocumentBuilder().setTitle('智注排产 API').setDescription('PP 注塑包装盒生产排产系统').setVersion('1.0').build(); SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config)); await app.listen(process.env.PORT ?? 3000); }
bootstrap();

import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import sharp from 'sharp';
import { emitExplorationProgress } from './progress';

/**
 * Capture and process screenshot for GPT-4o Vision
 * ✅ ENHANCED: Added error handling, validation, and edge case protection
 */
export async function captureAndProcessScreenshot(
  page: Page,
  sessionId?: string
): Promise<string> {
  try {
    logger.info('Capturing screenshot');
    emitExplorationProgress(sessionId, '📸 Taking page screenshot...');

    // Get page dimensions with error handling
    let fullHeight: number;
    try {
      const height = await page.evaluate(() => {
        // @ts-expect-error - browser context
        return document.body?.scrollHeight || window.innerHeight || 1080;
      });

      // Validate height
      if (typeof height !== 'number' || !isFinite(height) || height <= 0) {
        logger.warn('[SCREENSHOT] Invalid height from page.evaluate, using default', { height });
        fullHeight = 1080; // Default viewport height
      } else {
        fullHeight = Math.min(height, 50000); // Cap at 50k to prevent memory issues
      }
    } catch (evalError) {
      logger.warn('[SCREENSHOT] Failed to get page height, using default', {
        error: evalError instanceof Error ? evalError.message : String(evalError),
      });
      fullHeight = 1080; // Default viewport height
    }

    // Capture screenshot with error handling
    let screenshot: Buffer;
    try {
      screenshot = await page.screenshot({
        fullPage: fullHeight <= 10000,
        clip: fullHeight > 10000 ? {
          x: 0,
          y: 0,
          width: 1920,
          height: 10000,
        } : undefined,
        type: 'png',
        timeout: 30000, // 30 seconds timeout
      });

      // Validate screenshot is not empty
      if (!screenshot || screenshot.length === 0) {
        throw new Error('Screenshot is empty');
      }
    } catch (screenshotError) {
      logger.error('[SCREENSHOT] Failed to capture screenshot', {
        error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
      });
      throw new Error(`Failed to capture screenshot: ${screenshotError instanceof Error ? screenshotError.message : 'Unknown error'}`);
    }

    // Process with sharp for GPT-4o Vision
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(screenshot).metadata();
    } catch (sharpError) {
      logger.error('[SCREENSHOT] Failed to get image metadata', {
        error: sharpError instanceof Error ? sharpError.message : String(sharpError),
      });
      throw new Error(`Failed to process screenshot: ${sharpError instanceof Error ? sharpError.message : 'Unknown error'}`);
    }

    // Validate metadata and get dimensions
    // ✅ FIX: Use nullish coalescing instead of || to handle 0 values correctly
    const originalWidth = metadata.width ?? 1920;
    const originalHeight = metadata.height ?? fullHeight;

    // Validate dimensions
    if (!isFinite(originalWidth) || originalWidth <= 0 || !isFinite(originalHeight) || originalHeight <= 0) {
      logger.error('[SCREENSHOT] Invalid image dimensions', {
        width: originalWidth,
        height: originalHeight,
      });
      throw new Error(`Invalid screenshot dimensions: ${originalWidth}x${originalHeight}`);
    }

    logger.debug('Original screenshot dimensions', {
      width: originalWidth,
      height: originalHeight,
    });

    // Calculate resize dimensions (max 1024px on longest side)
    const MAX_DIMENSION = 1024;
    let resizeWidth = originalWidth;
    let resizeHeight = originalHeight;

    if (originalWidth > MAX_DIMENSION || originalHeight > MAX_DIMENSION) {
      // ✅ FIX: Prevent division by zero
      if (originalHeight === 0) {
        logger.error('[SCREENSHOT] Invalid aspect ratio (height is 0)', {
          width: originalWidth,
          height: originalHeight,
        });
        throw new Error('Invalid screenshot: height is 0');
      }

      const aspectRatio = originalWidth / originalHeight;

      if (originalWidth > originalHeight) {
        resizeWidth = MAX_DIMENSION;
        resizeHeight = Math.round(MAX_DIMENSION / aspectRatio);
      } else {
        resizeHeight = MAX_DIMENSION;
        resizeWidth = Math.round(MAX_DIMENSION * aspectRatio);
      }

      // ✅ FIX: Validate calculated dimensions
      if (!isFinite(resizeWidth) || resizeWidth <= 0 || !isFinite(resizeHeight) || resizeHeight <= 0) {
        logger.error('[SCREENSHOT] Invalid calculated resize dimensions', {
          resizeWidth,
          resizeHeight,
          aspectRatio,
        });
        // Fallback to max dimension for both
        resizeWidth = MAX_DIMENSION;
        resizeHeight = MAX_DIMENSION;
      }

      logger.info('Resizing screenshot for GPT-4o Vision', {
        original: `${originalWidth}x${originalHeight}`,
        resized: `${resizeWidth}x${resizeHeight}`,
        aspectRatio: aspectRatio.toFixed(2),
      });
    }

    // Resize with high-quality settings
    let resizedScreenshot: Buffer;
    try {
      resizedScreenshot = await sharp(screenshot)
        .resize(resizeWidth, resizeHeight, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'lanczos3',
        })
        .png({
          compressionLevel: 6, // 0-9: 6 = balanced (good compression, reasonable speed)
          // Note: PNG is lossless, so 'quality' parameter doesn't apply (only for JPEG)
        })
        .toBuffer();

      // Validate resized screenshot
      if (!resizedScreenshot || resizedScreenshot.length === 0) {
        throw new Error('Resized screenshot is empty');
      }
    } catch (resizeError) {
      logger.error('[SCREENSHOT] Failed to resize screenshot', {
        error: resizeError instanceof Error ? resizeError.message : String(resizeError),
        dimensions: `${resizeWidth}x${resizeHeight}`,
      });
      throw new Error(`Failed to resize screenshot: ${resizeError instanceof Error ? resizeError.message : 'Unknown error'}`);
    }

    const screenshotBase64 = resizedScreenshot.toString('base64');

    // Validate base64 string
    if (!screenshotBase64 || screenshotBase64.length === 0) {
      logger.error('[SCREENSHOT] Failed to convert screenshot to base64');
      throw new Error('Failed to convert screenshot to base64');
    }

    const screenshotSizeMB = Buffer.byteLength(screenshotBase64, 'base64') / (1024 * 1024);
    logger.info('Screenshot processed for GPT-4o Vision', {
      finalSize: `${resizeWidth}x${resizeHeight}`,
      sizeMB: screenshotSizeMB.toFixed(2),
      originalDimensions: `${originalWidth}x${originalHeight}`,
    });

    return screenshotBase64;
  } catch (error) {
    logger.error('[SCREENSHOT] Critical error in screenshot processing', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

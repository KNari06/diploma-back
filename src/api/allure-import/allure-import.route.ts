/**
 * Allure Import Routes
 *
 * POST /api/v1/allure-import/upload   — Upload a ZIP file and start import
 * GET  /api/v1/allure-import/status/:importId — Check import status
 */

import { Router } from 'express';
import multer from 'multer';
import { uploadAllure, getImportStatus } from './allure-import.controller';

const router = Router();

// ── Multer: memory storage, ZIP/CSV/PDF, 100 MB limit ────────────────────────
const allureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();

    const isZip =
      file.mimetype === 'application/zip' ||
      file.mimetype === 'application/x-zip-compressed' ||
      file.mimetype === 'application/octet-stream' ||
      lowerName.endsWith('.zip');

    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      lowerName.endsWith('.csv');

    const isPdf =
      file.mimetype === 'application/pdf' ||
      lowerName.endsWith('.pdf');

    if (isZip || isCsv || isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip, .csv, and .pdf files are accepted for Allure import'));
    }
  },
});

// POST /api/v1/allure-import/upload
router.post('/upload', allureUpload.single('file'), uploadAllure);

// GET  /api/v1/allure-import/status/:importId
router.get('/status/:importId', getImportStatus);

export default router;

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@/middleware/auth.middleware';
import * as kbController from './kb.controller';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/kb-uploads/', // Temporary directory
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'text/plain',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/json',
      'text/markdown',
    ];

    if (allowedTypes.includes(file.mimetype) || file.originalname.endsWith('.md')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: txt, pdf, docx, json, md'));
    }
  },
});

// All routes require authentication
router.use(requireAuth);

/**
 * @swagger
 * /api/v1/kb/global/upload:
 *   post:
 *     summary: Upload file to global KB (admin only)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               tags:
 *                 type: string
 *                 description: JSON array of tags
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *       403:
 *         description: Admin access required
 */
router.post('/global/upload', upload.single('file'), kbController.uploadGlobalKB);

/**
 * @swagger
 * /api/v1/kb/upload:
 *   post:
 *     summary: Upload file to project KB
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               projectId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: File uploaded successfully
 */
router.post('/upload', upload.single('file'), kbController.uploadProjectKB);

/**
 * @swagger
 * /api/v1/kb/query:
 *   post:
 *     summary: Query knowledge base (RAG search)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query:
 *                 type: string
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               matchThreshold:
 *                 type: number
 *                 default: 0.7
 *               matchCount:
 *                 type: number
 *                 default: 5
 *     responses:
 *       200:
 *         description: Search results
 */
router.post('/query', kbController.queryKB);

/**
 * @swagger
 * /api/v1/kb/project-files:
 *   get:
 *     summary: Get project KB files
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of files
 */
router.get('/project-files/chunks', kbController.getDocumentChunks);
router.get('/project-files', kbController.getProjectFiles);

/**
 * @swagger
 * /api/v1/kb/project-files:
 *   delete:
 *     summary: Delete project KB file
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               fileName:
 *                 type: string
 *     responses:
 *       200:
 *         description: File deleted
 */
router.delete('/project-files', kbController.deleteProjectFile);

/**
 * @swagger
 * /api/v1/kb/stats:
 *   get:
 *     summary: Get KB statistics (local global KB + project KB)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: KB statistics
 */
router.get('/stats', kbController.getKBStats);

/**
 * @swagger
 * /api/v1/kb/rebuild:
 *   post:
 *     summary: Rebuild global KB from source files (admin only)
 *     description: Regenerates embeddings.json from markdown files in data/global-kb/sources/ and reloads into memory
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: KB rebuilt successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     chunks:
 *                       type: number
 *                     files:
 *                       type: number
 *       403:
 *         description: Admin access required
 */
router.post('/rebuild', kbController.rebuildKB);

export default router;

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@/middleware/auth.middleware';
import * as analyticsController from './analytics.controller';
import * as autoLearnController from './auto-learn.controller';
import * as kbController from './kb.controller';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/kb-uploads/', // Temporary directory
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    // MIME types we accept directly. YAML has multiple common MIME strings so
    // we also fall back to extension-based allow-list for edge cases (curl,
    // browsers that upload yaml as application/octet-stream, etc.).
    const allowedMime = [
      'text/plain',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/json',
      'text/markdown',
      'application/x-yaml',
      'text/yaml',
      'text/x-yaml',
      'application/yaml',
    ];

    const nameLower = file.originalname.toLowerCase();
    const allowedExt = ['.md', '.markdown', '.yaml', '.yml', '.txt', '.pdf', '.docx', '.json'];
    const matchesExt = allowedExt.some((ext) => nameLower.endsWith(ext));

    if (allowedMime.includes(file.mimetype) || matchesExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: txt, pdf, docx, json, md, yaml, yml'));
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

/**
 * @swagger
 * /api/v1/kb/analytics/stats:
 *   get:
 *     summary: Retrieval stats overview (admin only)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 365, default: 7 }
 *     responses:
 *       200: { description: Stats }
 *       403: { description: Admin access required }
 */
router.get('/analytics/stats', analyticsController.getRetrievalStats);

/**
 * @swagger
 * /api/v1/kb/analytics/dead-files:
 *   get:
 *     summary: Files retrieved often but correlated with bad feedback (admin)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30 }
 *       - in: query
 *         name: minRetrievals
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: dislikeRatio
 *         schema: { type: number, minimum: 0, maximum: 1, default: 0.25 }
 *     responses:
 *       200: { description: Dead-file candidates }
 *       403: { description: Admin access required }
 */
router.get('/analytics/dead-files', analyticsController.getDeadFiles);

/**
 * @swagger
 * /api/v1/kb/analytics/events:
 *   get:
 *     summary: Raw retrieval events, paginated, most recent first (admin)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200: { description: Event rows }
 *       403: { description: Admin access required }
 */
router.get('/analytics/events', analyticsController.listRetrievalEvents);

/**
 * @swagger
 * /api/v1/kb/auto-learn/status:
 *   get:
 *     summary: Auto-learn toggle state + chunk stats for a project
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Status }
 *       403: { description: Project access denied }
 */
router.get('/auto-learn/status', autoLearnController.getAutoLearnStatus);

/**
 * @swagger
 * /api/v1/kb/auto-learn/toggle:
 *   put:
 *     summary: Enable/disable auto-learn for a project
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
 *               projectId: { type: string, format: uuid }
 *               enabled:   { type: boolean }
 *     responses:
 *       200: { description: Toggle result }
 *       403: { description: Project access denied }
 */
router.put('/auto-learn/toggle', autoLearnController.toggleAutoLearn);

/**
 * @swagger
 * /api/v1/kb/auto-learn/chunks:
 *   get:
 *     summary: List current auto-learned chunks for a project
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 50 }
 *     responses:
 *       200: { description: Chunks }
 *       403: { description: Project access denied }
 */
router.get('/auto-learn/chunks', autoLearnController.listAutoLearnChunks);

export default router;

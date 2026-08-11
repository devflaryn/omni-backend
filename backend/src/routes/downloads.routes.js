import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import { getManifest, downloadFile } from '../controllers/downloads.controller.js';

const downloadsRouter = Router();

// Path: /api/v1/downloads/...

downloadsRouter.get('/manifest', authorize, getManifest);
downloadsRouter.get('/file/:category/:platform', authorize, downloadFile);

export default downloadsRouter;

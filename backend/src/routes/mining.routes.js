import { Router } from 'express';
import authorize from '../middlewares/auth.middleware.js';
import { enroll, status } from '../controllers/mining.controller.js';

const miningRouter = Router();
// Path: /api/v1/mining/...
miningRouter.post('/enroll', authorize, enroll);
miningRouter.get('/status', authorize, status);
export default miningRouter;

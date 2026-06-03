import express from 'express'; import cors from 'cors'; import { analyzeRouter } from './routes/analyze';
const app = express(); const PORT = process.env.PORT || 3001;
app.use(cors()); app.use(express.json({ limit: '10mb' }));
app.use('/api', analyzeRouter);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.listen(PORT, () => console.log(`RevAI server running on http://localhost:${PORT}`));
export default app;

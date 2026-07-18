import { createRoot } from 'react-dom/client';
import QuestApp from './QuestApp.jsx';

// No StrictMode: questMain.start() is an imperative, run-once side effect (WebXR,
// WebRTC, render loop) with no teardown -- StrictMode's dev-mode double-invoke
// would start two overlapping peer connections and render loops.
createRoot(document.getElementById('root')).render(<QuestApp />);

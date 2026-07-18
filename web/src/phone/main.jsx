import { createRoot } from 'react-dom/client';
import PhoneApp from './PhoneApp.jsx';

// No StrictMode: phoneMain.start() is an imperative, run-once side effect (camera,
// WebRTC, robot bridge) with no teardown -- StrictMode's dev-mode double-invoke
// would open the camera and signaling loop twice.
createRoot(document.getElementById('root')).render(<PhoneApp />);

import { useEffect } from 'react';
import { start } from './questMain.js';

// Thin wrapper: renders the same overlay markup the old vanilla app.js expected by
// ID, then hands off to questMain.start() which does everything else imperatively
// (three.js scene, WebXR session, WebRTC). See web/src/quest/questMain.js.
export default function QuestApp() {
  useEffect(() => {
    start();
  }, []);

  return (
    <div id="overlay">
      <div>Robot Teleop</div>
      <button id="enterVr" disabled>Checking WebXR support...</button>
      <div id="config">Append <code>?token=YOUR_TOKEN</code> to this page's URL if not already present.</div>
    </div>
  );
}

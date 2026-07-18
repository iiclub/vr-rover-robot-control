import { useEffect } from 'react';
import { start } from './phoneMain.js';

// Thin wrapper: renders the same HUD markup the old vanilla app.js expected by ID,
// then hands off to phoneMain.start() which does all the actual work imperatively
// (camera, WebRTC, NodeMCU bridge). See web/src/phone/phoneMain.js.
export default function PhoneApp() {
  useEffect(() => {
    start();
  }, []);

  return (
    <>
      <video id="preview" autoPlay playsInline muted />
      <div id="hud">
        <div id="status">
          <span id="dot" />
          <span id="statusText">connecting...</span>
        </div>
        <div id="stats" />
      </div>
      <div id="robotUrlBar">
        <input id="robotUrlInput" type="text" placeholder="ws://robot.local:81" />
        <button id="robotUrlSave">Save</button>
      </div>
    </>
  );
}

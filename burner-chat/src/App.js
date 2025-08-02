import { useEffect, useRef, useState } from 'react';

// const SERVER_URL = "ws://localhost:8000/ws";
const SERVER_URL = "wss://burner-chat-server.onrender.com/ws";

// Helpers
function bufferToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function App() {
  const [room, setRoom] = useState('');
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [exitCountdown, setExitCountdown] = useState(null);

  const privateKeyRef = useRef(null);
  const sharedKeyRef = useRef(null);
  const myPublicKeyRef = useRef(null);
  const keyEstablishedRef = useRef(false);
  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  useEffect(() => {
    const cleanup = () => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close();
      }
    };
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, []);

  const joinRoom = async () => {
    const keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveKey", "deriveBits"]
    );

    const exportedPublicKey = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    myPublicKeyRef.current = exportedPublicKey;
    privateKeyRef.current = keyPair.privateKey;

    socketRef.current = new WebSocket(`${SERVER_URL}/${room}`);

    socketRef.current.onopen = () => {
      socketRef.current.send(JSON.stringify({
        type: "key",
        data: myPublicKeyRef.current
      }));
    };

    socketRef.current.onmessage = async (event) => {
      if (event.data === "ROOM_FULL") {
        alert("Room already has 2 participants.");
        socketRef.current.close();
        return;
      }

      const payload = JSON.parse(event.data);

      if (payload.type === "key") {
        const importedPeerKey = await window.crypto.subtle.importKey(
          "jwk",
          payload.data,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          []
        );

        const derivedKey = await window.crypto.subtle.deriveKey(
          {
            name: "ECDH",
            public: importedPeerKey
          },
          privateKeyRef.current,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );

        if (!keyEstablishedRef.current) {
          sharedKeyRef.current = derivedKey;
          keyEstablishedRef.current = true;
          setIsEncrypted(true);

          socketRef.current.send(JSON.stringify({
            type: "key",
            data: myPublicKeyRef.current
          }));
        }
      }

      if (payload.type === "msg") {
        if (!sharedKeyRef.current) return;

        try {
          const iv = base64ToBuffer(payload.iv);
          const ciphertext = base64ToBuffer(payload.data);
          const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            sharedKeyRef.current,
            ciphertext
          );
          const message = new TextDecoder().decode(decrypted);
          setMessages(prev => [...prev, { from: "Peer", text: message }]);
        } catch (err) {
          console.error("❌ Decryption failed:", err);
        }
      }

      if (payload.type === "typing") {
        setPeerTyping(true);
      }

      if (payload.type === "stopped_typing") {
        setPeerTyping(false);
      }

      if (payload.type === "peer_left") {
        let countdown = 5;
        setExitCountdown(countdown);
        setMessages(prev => [...prev, {
          from: "System",
          text: `Peer has left. You will be redirected in 5s...`
        }]);
        countdownTimerRef.current = setInterval(() => {
          countdown--;
          setExitCountdown(countdown);
          if (countdown === 0) {
            clearInterval(countdownTimerRef.current);
            cleanupAndReset();
          }
        }, 1000);
      }
    };

    setJoined(true);
  };

  const sendMessage = async () => {
    if (!input.trim() || !sharedKeyRef.current) return;

    const encoded = new TextEncoder().encode(input);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sharedKeyRef.current,
      encoded
    );

    socketRef.current.send(JSON.stringify({
      type: "msg",
      data: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv)
    }));

    setMessages(prev => [...prev, { from: 'You', text: input }]);
    setInput('');
  };

  const handleTyping = (e) => {
    setInput(e.target.value);

    if (sharedKeyRef.current) {
      socketRef.current.send(JSON.stringify({ type: "typing" }));
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current.send(JSON.stringify({ type: "stopped_typing" }));
    }, 1000);
  };

  const cleanupAndReset = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close();
    }
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);

    setJoined(false);
    setRoom('');
    setMessages([]);
    setInput('');
    setPeerTyping(false);
    setIsEncrypted(false);
    setExitCountdown(null);
    keyEstablishedRef.current = false;
    sharedKeyRef.current = null;
  };

  const handleExitChat = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close();
    }
    cleanupAndReset();
  };

  return (
    <div style={{ padding: 20 }}>
      {!joined ? (
        <>
          <input
            placeholder="Room ID"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          <button onClick={joinRoom}>Join</button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            {isEncrypted ? "🔐 Encrypted" : "🔓 Not Secure"}
          </div>

          {peerTyping && (
            <div style={{ fontStyle: "italic", color: "gray", marginBottom: 5 }}>
              Peer is typing...
            </div>
          )}

          <div style={{
            height: 300,
            overflowY: 'scroll',
            border: '1px solid #ccc',
            marginBottom: 10,
            padding: '0.5rem'
          }}>
            {messages.map((msg, i) => (
              <div key={i}><strong>{msg.from}:</strong> {msg.text}</div>
            ))}
          </div>

          {exitCountdown !== null && (
            <div style={{ color: 'red', fontWeight: 'bold', marginBottom: 10 }}>
              Peer left — returning to home in {exitCountdown}s...
            </div>
          )}

          <input
            placeholder="Type message"
            value={input}
            onChange={handleTyping}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <button onClick={sendMessage}>Send</button>
          <button
            onClick={handleExitChat}
            style={{ marginLeft: 10, backgroundColor: 'red', color: 'white' }}
          >
            Exit Chat
          </button>
        </>
      )}
    </div>
  );
}

export default App;

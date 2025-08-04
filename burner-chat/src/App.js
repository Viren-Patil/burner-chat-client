import { useEffect, useRef, useState } from 'react';
import './App.css';

const SERVER_URL = "wss://burner-chat-server.onrender.com/ws";
// const SERVER_URL = "ws://localhost:8000/ws";
const emojiOptions = ['👍', '❤️', '😂', '😮', '😢', '🔥'];


function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
  const [username, setUsername] = useState('');
  const [peerName, setPeerName] = useState('Peer');
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [showTypingBubble, setShowTypingBubble] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [exitCountdown, setExitCountdown] = useState(null);
  const [showEncryptionInfo, setShowEncryptionInfo] = useState(false);
  const [messageReactions, setMessageReactions] = useState({});
  const [hoveredMessage, setHoveredMessage] = useState(null);


  const privateKeyRef = useRef(null);
  const sharedKeyRef = useRef(null);
  const myPublicKeyRef = useRef(null);
  const keyEstablishedRef = useRef(false);
  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const peerNameRef = useRef('Peer');
  const longPressTimeoutRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, showTypingBubble]);

  useEffect(() => {
    const cleanup = () => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close();
      }
    };
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, []);

  function formatTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }


  const handleImageUpload = async (e) => {
    const now = new Date();
    const file = e.target.files[0];
    if (!file || !sharedKeyRef.current) return;

    const arrayBuffer = await file.arrayBuffer();

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sharedKeyRef.current,
      arrayBuffer
    );

    socketRef.current.send(JSON.stringify({
      type: "img",
      data: bufferToBase64(encrypted),
      iv: bufferToBase64(iv),
      mime: file.type
    }));

    // Show your own image immediately
    const localURL = URL.createObjectURL(file);
    setMessages(prev => [...prev, { from: 'You', image: localURL, time: now.toISOString() }]);

    e.target.value = null;
  };


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
      socketRef.current.send(JSON.stringify({ type: "key", data: myPublicKeyRef.current }));
      socketRef.current.send(JSON.stringify({ type: "name", data: username }));
    };

    socketRef.current.onmessage = async (event) => {

      const now = new Date();

      if (event.data === "ROOM_FULL") {
        alert("Room already has 2 participants.");
        socketRef.current.close();
        return;
      }

      const payload = JSON.parse(event.data);

      if (payload.type === "name") {
        setPeerName(payload.data);
        peerNameRef.current = payload.data;
      }

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
          socketRef.current.send(JSON.stringify({ type: "key", data: myPublicKeyRef.current }));
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
          setMessages(prev => [...prev, { from: peerNameRef.current, text: message, time: now.toISOString() }]);
        } catch (err) {
          console.error("❌ Decryption failed:", err);
        }
      }

      if (payload.type === "typing") {
        setShowTypingBubble(true);
      }

      if (payload.type === "stopped_typing") {
        setShowTypingBubble(false);
      }

      if (payload.type === "peer_left") {
        let countdown = 5;
        setExitCountdown(countdown);
        setMessages(prev => [...prev, { from: "System", text: `${peerNameRef.current} has left. You will be redirected in 5s...`, time: now.toISOString() }]);
        countdownTimerRef.current = setInterval(() => {
          countdown--;
          setExitCountdown(countdown);
          if (countdown === 0) {
            clearInterval(countdownTimerRef.current);
            cleanupAndReset();
          }
        }, 1000);
      }

      if (payload.type === "img") {
        if (!sharedKeyRef.current) return;
        try {
          const iv = base64ToBuffer(payload.iv);
          const encryptedData = base64ToBuffer(payload.data);
          const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            sharedKeyRef.current,
            encryptedData
          );

          const blob = new Blob([decrypted], { type: payload.mime });
          const url = URL.createObjectURL(blob);
          setMessages(prev => [...prev, { from: peerNameRef.current, image: url, time: now.toISOString() }]);
        } catch (err) {
          console.error("❌ Image decryption failed:", err);
        }
      }

      if (payload.type === "reaction") {
        const { index, emoji } = payload;
        setMessageReactions(prev => ({
          ...prev,
          [index]: emoji,
        }));
      }

    };

    setJoined(true);
  };

  const sendMessage = async () => {
    if (!input.trim() || !sharedKeyRef.current) return;

    const now = new Date();
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

    setMessages(prev => [...prev, { from: 'You', text: input, time: now.toISOString() }]);
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
    setIsEncrypted(false);
    setExitCountdown(null);
    setPeerName('Peer');
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
    <div className="chat-container">
      {!joined ? (
        <div className="join-screen">
          <div className="input-row">
            <input
              className="input"
              placeholder="Your Name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="input"
              placeholder="Room ID"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
            />
          </div>
          <button className="button join-button" onClick={joinRoom}>Join</button>
        </div>
      ) : (
        <div className="chat-window">
          <div className="chat-header">
            <span>
              {isEncrypted ? "🔐 Encrypted" : "🔓 Not Secure"}
              <i 
                className="fa-solid fa-circle-info" 
                title="What is encryption?"
                onClick={() => setShowEncryptionInfo(true)} 
                style={{ marginLeft: '0.5rem', cursor: 'pointer', color: '#114b5f' }}
              ></i>
            </span>
            <span>Talking to <strong>{peerName}</strong> | <i class="fa-solid fa-right-from-bracket" onClick={handleExitChat} title="Exit chat"></i></span>
          </div>

          {!isEncrypted && (
            <div className="loading-overlay">
              <div className="spinner" />
              <p>Establishing encryption…</p>
            </div>
          )}

          <div className="chat-messages">
            {messages.length > 0 && messages[0].time && (
              <div className="date-banner">
                {formatDate(messages[0].time)}
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`chat-bubble ${msg.from === 'You' ? 'outgoing' : 'incoming'}`}
                onMouseEnter={() => setHoveredMessage(i)}
                onMouseLeave={() => setHoveredMessage(null)}
                onTouchStart={() => {
                longPressTimeoutRef.current = setTimeout(() => {
                    setHoveredMessage(i);
                  }, 500);
                }}
                onTouchEnd={() => {
                  clearTimeout(longPressTimeoutRef.current);
                }}
                onTouchMove={() => {
                  clearTimeout(longPressTimeoutRef.current);
                }}
              >
                <div className="chat-author">{msg.from}</div>
                {msg.image ? (
                  <div className="chat-image">
                    <img src={msg.image} alt="sent" />
                  </div>
                ) : (
                  <div className="chat-text">{msg.text}</div>
                )}
                {msg.time && (
                  <div className="chat-time">{formatTime(msg.time)}</div>
                )}

                {hoveredMessage === i && msg.from !== 'You' && (
                  <div className="emoji-popup">
                    {emojiOptions.map((emoji) => (
                      <span
                        key={emoji}
                        className="emoji-option"
                        onClick={() => {
                          setMessageReactions((prev) => ({
                            ...prev,
                            [i]: prev[i] === emoji ? null : emoji,
                          }));

                          socketRef.current.send(JSON.stringify({
                            type: "reaction",
                            index: i,
                            emoji: emoji === messageReactions[i] ? null : emoji,
                          }));

                        }}
                      >
                        {emoji}
                      </span>
                    ))}
                  </div>
                )}

                {messageReactions[i] && (
                  <div className="emoji-reaction">
                    {messageReactions[i]}
                  </div>
                )}
              </div>
            ))}

            {showTypingBubble && (
              <div className="chat-bubble incoming">
                <div className="chat-author">{peerName}</div>
                <div className="typing-dots">
                  <span></span><span></span><span></span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {exitCountdown !== null && (
            <div className="exit-warning">
              Peer left — returning to home in {exitCountdown}s...
            </div>
          )}

          <div className="chat-input">
            <input
              className="input"
              placeholder="Type message"
              value={input}
              onChange={handleTyping}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            />
            <button className="button send" onClick={sendMessage}>
              <i class="fa-solid fa-paper-plane"></i>
            </button>
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              id="image-upload"
              onChange={handleImageUpload}
            />
            <label htmlFor="image-upload" className="button image-upload">
              <i className="fa-solid fa-image"></i>
            </label>
          </div>
        </div>
      )}

      {showEncryptionInfo && (
        <div className="encryption-modal">
          <div className="modal-content">
            <h2>End-to-End Encryption 🔐</h2>
            <p>
              Messages and images you send are encrypted on your device and can only be decrypted by the other person. 
              No one—not even the server—can read your messages.
            </p>
            <p>
              Once the chat ends, all keys are discarded. Nothing is saved or stored anywhere.
            </p>
            <button onClick={() => setShowEncryptionInfo(false)}>Got it</button>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;

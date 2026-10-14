# finish_reason=length — measurement

Model `openai/gpt-oss-20b`. 2026-10-14T22:48:15.387Z.

222 LLM calls, 898766 tokens spent. Long-note runs per arm: 10 uncapped, 10 capped. Guard runs: 2 per case per arm.

| arm | cut | empty content | completion tokens med/max | seconds med/max | verbatim | routed | rejected calls |
|---|---|---|---|---|---|---|---|
| medium (unset) / no cap | 2/10 | 2/10 | 1781 / 2048 | 3.2 / 4.5 | 6/6 | 7/10 | 0/26 |
| medium (unset) / 4096 | 1/10 | 1/10 | 2759 / 4096 | 4.9 / 10.6 | 6/6 | 7/10 | 0/26 |
| low / no cap | 0/10 | 0/10 | 85 / 91 | 1.3 / 1.6 | 6/6 | 8/10 | 2/26 |
| low / 4096 | 0/10 | 0/10 | 84 / 91 | 0.9 / 1.4 | 6/6 | 8/10 | 0/26 |

## Every run

| arm | case | run | verdict | finish | chars | completion | s | calls | tokens | route |
|---|---|---|---|---|---|---|---|---|---|---|
| medium (unset) / no cap | long | 1 | cut | length | 0 | 2048 | 3.2 | 2 | 9590 | save_note |
| medium (unset) / no cap | long | 2 | summarized | stop | 204 | 1478 | 3.7 | 3 | 13316 | search_notes → save_note |
| medium (unset) / no cap | long | 3 | cut | length | 0 | 2048 | 4.5 | 3 | 14004 | search_notes → save_note |
| medium (unset) / no cap | long | 4 | summarized | stop | 236 | 936 | 2.0 | 2 | 8839 | save_note |
| medium (unset) / no cap | long | 5 | summarized | stop | 268 | 1701 | 3.2 | 2 | 9937 | save_note |
| medium (unset) / no cap | long | 6 | summarized | stop | 205 | 481 | 2.0 | 2 | 8231 | save_note |
| medium (unset) / no cap | long | 7 | summarized | stop | 192 | 1930 | 3.1 | 2 | 9822 | save_note |
| medium (unset) / no cap | long | 8 | summarized | stop | 203 | 1154 | 3.3 | 3 | 14496 | search_notes → save_note |
| medium (unset) / no cap | long | 9 | summarized | stop | 178 | 1943 | 3.0 | 2 | 9712 | save_note |
| medium (unset) / no cap | long | 10 | summarized | stop | 199 | 1860 | 3.2 | 2 | 9940 | save_note |
| medium (unset) / no cap | path | 1 | verbatim | stop | 99 | 246 | 1.0 | 2 | 7881 | save_note |
| medium (unset) / no cap | path | 2 | verbatim | stop | 76 | 129 | 0.8 | 2 | 7698 | save_note |
| medium (unset) / no cap | name | 1 | verbatim | stop | 58 | 255 | 1.0 | 2 | 7819 | save_note |
| medium (unset) / no cap | name | 2 | verbatim | stop | 58 | 249 | 1.2 | 2 | 7975 | save_note |
| medium (unset) / no cap | digits | 1 | verbatim | stop | 72 | 113 | 1.1 | 2 | 7707 | save_note |
| medium (unset) / no cap | digits | 2 | verbatim | stop | 72 | 190 | 1.0 | 2 | 7750 | save_note |
| medium (unset) / no cap | route-11 | 1 | routed | stop | 31 | 45 | 0.7 | 2 | 7152 | remember_preference |
| medium (unset) / no cap | route-11 | 2 | routed | stop | 137 | 641 | 1.2 | 2 | 7769 | remember_preference |
| medium (unset) / no cap | route-12 | 1 | misrouted | stop | 7 | 39 | 0.6 | 2 | 7225 | remember_preference |
| medium (unset) / no cap | route-12 | 2 | misrouted | stop | 85 | 58 | 1.0 | 2 | 7393 | remember_preference |
| medium (unset) / no cap | route-13 | 1 | routed | stop | 35 | 188 | 0.6 | 2 | 7297 | search_memory |
| medium (unset) / no cap | route-13 | 2 | routed | stop | 173 | 472 | 1.0 | 2 | 7577 | search_memory |
| medium (unset) / no cap | route-14 | 1 | routed | stop | 159 | 214 | 0.8 | 2 | 8012 | search_notes |
| medium (unset) / no cap | route-14 | 2 | routed | stop | 44 | 112 | 0.8 | 2 | 7846 | search_notes |
| medium (unset) / no cap | route-15 | 1 | routed | stop | 31 | 37 | 1.0 | 2 | 7505 | remember_preference |
| medium (unset) / no cap | route-15 | 2 | misrouted | stop | 103 | 258 | 2.3 | 4 | 16372 | remember_preference → search_notes → save_note |
| medium (unset) / 4096 | long | 1 | summarized | stop | 204 | 3108 | 4.4 | 2 | 10978 | save_note |
| medium (unset) / 4096 | long | 2 | summarized | stop | 313 | 358 | 1.5 | 2 | 8227 | save_note |
| medium (unset) / 4096 | long | 3 | summarized | stop | 207 | 3264 | 5.1 | 2 | 11153 | save_note |
| medium (unset) / 4096 | long | 4 | summarized | stop | 202 | 2644 | 4.6 | 2 | 10562 | save_note |
| medium (unset) / 4096 | long | 5 | summarized | stop | 188 | 2874 | 5.8 | 3 | 15992 | search_notes → save_note |
| medium (unset) / 4096 | long | 6 | cut | length | 0 | 4096 | 7.0 | 2 | 12226 | save_note |
| medium (unset) / 4096 | long | 7 | summarized | stop | 210 | 2401 | 5.3 | 3 | 16023 | search_notes → save_note |
| medium (unset) / 4096 | long | 8 | summarized | stop | 171 | 3979 | 10.6 | 3 | 16557 | search_notes → save_note |
| medium (unset) / 4096 | long | 9 | summarized | stop | 201 | 1564 | 4.7 | 3 | 14148 | search_notes → save_note |
| medium (unset) / 4096 | long | 10 | summarized | stop | 308 | 259 | 1.2 | 2 | 8174 | save_note |
| medium (unset) / 4096 | path | 1 | verbatim | stop | 85 | 130 | 0.8 | 2 | 7628 | save_note |
| medium (unset) / 4096 | path | 2 | verbatim | stop | 179 | 450 | 1.1 | 2 | 8056 | save_note |
| medium (unset) / 4096 | name | 1 | verbatim | stop | 163 | 2105 | 3.1 | 2 | 9630 | save_note |
| medium (unset) / 4096 | name | 2 | verbatim | stop | 99 | 294 | 1.2 | 2 | 7896 | save_note |
| medium (unset) / 4096 | digits | 1 | verbatim | stop | 72 | 106 | 0.9 | 2 | 7746 | save_note |
| medium (unset) / 4096 | digits | 2 | verbatim | stop | 72 | 225 | 1.3 | 2 | 7833 | save_note |
| medium (unset) / 4096 | route-11 | 1 | routed | stop | 31 | 48 | 0.6 | 2 | 7230 | remember_preference |
| medium (unset) / 4096 | route-11 | 2 | routed | stop | 49 | 42 | 0.5 | 2 | 7191 | remember_preference |
| medium (unset) / 4096 | route-12 | 1 | misrouted | stop | 7 | 40 | 0.5 | 2 | 7242 | remember_preference |
| medium (unset) / 4096 | route-12 | 2 | misrouted | stop | 67 | 137 | 0.6 | 2 | 7324 | remember_preference |
| medium (unset) / 4096 | route-13 | 1 | routed | stop | 91 | 160 | 0.8 | 2 | 7277 | search_memory |
| medium (unset) / 4096 | route-13 | 2 | routed | stop | 99 | 247 | 0.8 | 2 | 7388 | search_memory |
| medium (unset) / 4096 | route-14 | 1 | routed | stop | 110 | 258 | 1.0 | 2 | 7964 | search_notes |
| medium (unset) / 4096 | route-14 | 2 | routed | stop | 160 | 227 | 0.7 | 2 | 7920 | search_notes |
| medium (unset) / 4096 | route-15 | 1 | routed | stop | 148 | 265 | 1.0 | 2 | 7498 | remember_preference |
| medium (unset) / 4096 | route-15 | 2 | misrouted | stop | 79 | 257 | 1.4 | 3 | 12209 | save_note → save_note |
| low / no cap | long | 1 | summarized | stop | 334 | 91 | 1.6 | 2 | 7788 | save_note |
| low / no cap | long | 2 | summarized | stop | 301 | 83 | 1.2 | 2 | 7783 | save_note (1 rejected) |
| low / no cap | long | 3 | summarized | stop | 307 | 85 | 1.1 | 2 | 7709 | save_note |
| low / no cap | long | 4 | summarized | stop | 307 | 85 | 1.6 | 2 | 7776 | save_note (1 rejected) |
| low / no cap | long | 5 | summarized | stop | 340 | 90 | 1.0 | 2 | 7799 | save_note |
| low / no cap | long | 6 | summarized | stop | 307 | 85 | 1.1 | 2 | 7776 | save_note |
| low / no cap | long | 7 | summarized | stop | 339 | 90 | 1.4 | 2 | 7787 | save_note |
| low / no cap | long | 8 | summarized | stop | 303 | 83 | 1.3 | 2 | 7795 | save_note |
| low / no cap | long | 9 | summarized | stop | 333 | 90 | 1.3 | 2 | 7792 | save_note |
| low / no cap | long | 10 | summarized | stop | 227 | 69 | 0.9 | 2 | 7772 | save_note |
| low / no cap | path | 1 | verbatim | stop | 97 | 43 | 1.0 | 3 | 11835 | save_note → save_note |
| low / no cap | path | 2 | verbatim | stop | 97 | 43 | 2.7 | 3 | 11836 | save_note → save_note |
| low / no cap | name | 1 | verbatim | stop | 74 | 47 | 0.6 | 2 | 7428 | save_note |
| low / no cap | name | 2 | verbatim | stop | 125 | 62 | 0.8 | 2 | 7508 | save_note |
| low / no cap | digits | 1 | verbatim | stop | 72 | 51 | 0.7 | 2 | 7584 | save_note |
| low / no cap | digits | 2 | verbatim | stop | 72 | 51 | 1.0 | 2 | 7586 | save_note |
| low / no cap | route-11 | 1 | routed | stop | 35 | 23 | 2.0 | 2 | 7079 | remember_preference |
| low / no cap | route-11 | 2 | routed | stop | 31 | 24 | 0.7 | 2 | 7080 | remember_preference |
| low / no cap | route-12 | 1 | misrouted | stop | 155 | 56 | 0.7 | 2 | 7180 | remember_preference |
| low / no cap | route-12 | 2 | misrouted | stop | 48 | 30 | 0.6 | 2 | 7155 | remember_preference |
| low / no cap | route-13 | 1 | routed | stop | 63 | 33 | 0.5 | 2 | 7099 | search_memory |
| low / no cap | route-13 | 2 | routed | stop | 59 | 29 | 0.6 | 2 | 7095 | search_memory |
| low / no cap | route-14 | 1 | routed | stop | 52 | 52 | 1.8 | 2 | 7705 | search_notes |
| low / no cap | route-14 | 2 | routed | stop | 44 | 53 | 0.5 | 2 | 7702 | search_notes |
| low / no cap | route-15 | 1 | routed | stop | 46 | 39 | 0.5 | 2 | 7117 | remember_preference |
| low / no cap | route-15 | 2 | routed | stop | 42 | 35 | 0.5 | 2 | 7093 | remember_preference |
| low / 4096 | long | 1 | summarized | stop | 301 | 84 | 1.4 | 2 | 7786 | save_note |
| low / 4096 | long | 2 | summarized | stop | 331 | 91 | 1.1 | 2 | 7792 | save_note |
| low / 4096 | long | 3 | summarized | stop | 302 | 86 | 1.3 | 2 | 7780 | save_note |
| low / 4096 | long | 4 | summarized | stop | 300 | 84 | 0.9 | 2 | 7706 | save_note |
| low / 4096 | long | 5 | summarized | stop | 229 | 69 | 0.9 | 2 | 7770 | save_note |
| low / 4096 | long | 6 | summarized | stop | 330 | 91 | 1.1 | 2 | 7792 | save_note |
| low / 4096 | long | 7 | summarized | stop | 305 | 83 | 0.7 | 2 | 7783 | save_note |
| low / 4096 | long | 8 | summarized | stop | 228 | 69 | 0.9 | 2 | 7764 | save_note |
| low / 4096 | long | 9 | summarized | stop | 296 | 83 | 0.8 | 2 | 7780 | save_note |
| low / 4096 | long | 10 | summarized | stop | 327 | 90 | 0.9 | 2 | 7803 | save_note |
| low / 4096 | path | 1 | verbatim | stop | 99 | 43 | 1.1 | 3 | 11870 | save_note → save_note |
| low / 4096 | path | 2 | verbatim | stop | 99 | 46 | 0.9 | 3 | 11945 | save_note → save_note |
| low / 4096 | name | 1 | verbatim | stop | 74 | 47 | 0.5 | 2 | 7431 | save_note |
| low / 4096 | name | 2 | verbatim | stop | 74 | 47 | 0.5 | 2 | 7428 | save_note |
| low / 4096 | digits | 1 | verbatim | stop | 72 | 51 | 0.6 | 2 | 7583 | save_note |
| low / 4096 | digits | 2 | verbatim | stop | 70 | 39 | 0.6 | 2 | 7574 | save_note |
| low / 4096 | route-11 | 1 | routed | stop | 94 | 40 | 0.5 | 2 | 7096 | remember_preference |
| low / 4096 | route-11 | 2 | routed | stop | 142 | 51 | 1.0 | 2 | 7107 | remember_preference |
| low / 4096 | route-12 | 1 | misrouted | stop | 105 | 45 | 0.6 | 2 | 7169 | remember_preference |
| low / 4096 | route-12 | 2 | misrouted | stop | 151 | 54 | 0.5 | 2 | 7153 | remember_preference |
| low / 4096 | route-13 | 1 | routed | stop | 57 | 28 | 0.7 | 2 | 7094 | search_memory |
| low / 4096 | route-13 | 2 | routed | stop | 112 | 47 | 0.5 | 2 | 7113 | search_memory |
| low / 4096 | route-14 | 1 | routed | stop | 44 | 61 | 1.0 | 2 | 7710 | search_notes |
| low / 4096 | route-14 | 2 | routed | stop | 44 | 67 | 0.7 | 2 | 7716 | search_notes |
| low / 4096 | route-15 | 1 | routed | stop | 62 | 40 | 0.4 | 2 | 7115 | remember_preference |
| low / 4096 | route-15 | 2 | routed | stop | 77 | 35 | 0.6 | 2 | 7110 | remember_preference |

## Replies

- **medium (unset) / no cap / long 1** (cut): ""
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 2** (summarized): "I saved a note titled Backend Deployment Details the backend runs in WSL two on the gaming PC, speech sidecars started by harness, Qdrant and Ollama in Docker, desktop client uses local network. Ask part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 3** (cut): ""
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 4** (summarized): "Saved note “Backend Deployment Details”: Backend runs in WSL two on the gaming PC, speech sidecars started by the harness, Qdrant and Ollama in Docker, desktop client uses local network. The note is long; let me know if you want a part."
  - on disk: "The core backend runs inside Windows Subsystem for Linux two on the gaming PC. The speech sidecars are launched automatically by the harness process. Both Qdrant and Ollama are containerized and run in Docker. The desktop client connects to the backend over the local network rather than via loopback."
- **medium (unset) / no cap / long 5** (summarized): "I saved Backend Deployment Details that the backend runs in WSL two on gaming PC, speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and desktop client connects over local network. The note is long, so let me know if you want a specific part."
  - on disk: "The core backend service runs inside Windows Subsystem for Linux version two on the gaming PC. This provides a lightweight Linux kernel and filesystem while still being integrated with the host Windows environment. The speech processing sidecars are launched automatically by the harness process. They are not started manually; the harness ensures they are up and running whenever the backend starts. Both Qdrant, the vector database, and Ollama, the LLM runtime, are deployed as Docker containers. They share the same Docker network and are managed by Docker Compose for ease of scaling and maintenance. The desktop client connects to the backend over the local network using the machine's LAN IP address, rather than the loopback interface. This allows multiple devices on the same network to access the service."
- **medium (unset) / no cap / long 6** (summarized): "Saved reference note “Backend Architecture”: Backend runs in WSL two, sidecars via harness, Qdrant and Ollama in Docker, desktop client uses local network. The note is long; let me know if you want a part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 7** (summarized): "Saved a note titled Backend Deployment Details. It says backend runs in WSL two on gaming PC, Qdrant and Ollama in Docker, desktop client uses local network. Let me know if you want a summary."
  - on disk: "The backend runs inside Windows Subsystem for Linux two on the gaming PC. The speech sidecars are launched automatically by the harness. Both Qdrant and Ollama are containerized in Docker. The desktop client connects to the backend over the local network, not via loopback."
- **medium (unset) / no cap / long 8** (summarized): "I saved a note 'Backend Deployment Details' that the backend runs in WSL two on gaming PC, speech sidecars are started by harness, Qdrant Ollama are in Docker, desktop client connects over local network."
  - on disk: "The core backend of the system is hosted inside Windows Subsystem for Linux two on the gaming PC. This allows the backend to run natively on Linux binaries while still being accessible from the Windows host. The harness process, which orchestrates the overall system, automatically launches the speech sidecars. These sidecars are lightweight services that handle speech synthesis and recognition, and they are started as part of the harness bootstrap. Both Qdrant, the vector database, and Ollama, the LLM runtime, are containerized and run in Docker. Docker provides isolation and consistent environments for these services, making it easier to manage dependencies and updates. The containers are started by the harness as well, ensuring that all components are up and running together. The desktop client does not connect to the backend via the loopback interface. Instead, it uses the local network interface, which allows the client to communicate with the backend over the LAN. This design choice simplifies network configuration and avoids potential issues with port forwarding or NAT when the client and backend are on the same machine. In summary, the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 9** (summarized): "I saved a note Backend infrastructure details. It says the backend runs in WSL two on the gaming PC and the desktop client uses the local network. Let me know if you want a part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / no cap / long 10** (summarized): "I saved a note titled 'Backend environment details' backend runs in WSL two on the gaming PC, sidecars started by harness, Qdrant and Ollama run in Docker, desktop client connects over local network."
  - on disk: "The core backend service runs inside Windows Subsystem for Linux two on the gaming PC. It is a Linux environment that hosts the main application logic. The speech sidecar processes are launched automatically by the harness that starts the backend. They run as separate containers or processes within the same WSL environment. Both Qdrant, the vector database, and Ollama, the local language model host, are deployed as Docker containers. They share the same Docker network as the backend. The desktop client connects to the backend over the local network using the PC’s LAN IP address, not via the loopback interface. This allows remote access from other devices on the same network."
- **medium (unset) / no cap / path 1** (verbatim): "I saved the note: The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **medium (unset) / no cap / path 2** (verbatim): "I saved the note: The Ixa repository is located at /home/wyatt/Projects/ixa."
  - on disk: "The Ixa repository is located at /home/wyatt/Projects/ixa."
- **medium (unset) / no cap / name 1** (verbatim): "I saved a note: Wyatt Fisher is the owner of this machine."
  - on disk: "Wyatt Fisher is the owner of this machine."
- **medium (unset) / no cap / name 2** (verbatim): "I saved a note: The owner of this machine is Wyatt Fisher."
  - on disk: "The owner of this machine is Wyatt Fisher."
- **medium (unset) / no cap / digits 1** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **medium (unset) / no cap / digits 2** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **medium (unset) / no cap / route-11 1** (routed): "Got it. I’ll keep that in mind."
  - note: remember_preference
- **medium (unset) / no cap / route-11 2** (routed): "Got it, you like your coffee black. I'll keep that in mind for future coffee suggestions. If you want a brew or recipe, just let me know."
  - note: remember_preference
- **medium (unset) / no cap / route-12 1** (misrouted): "Got it."
  - note: save_note
- **medium (unset) / no cap / route-12 2** (misrouted): "Saved new preference [technical] stt sidecar language model: uses base.en, not small."
  - note: save_note
- **medium (unset) / no cap / route-13 1** (routed): "I can't access my memory right now."
  - note: search_memory with no query
- **medium (unset) / no cap / route-13 2** (routed): "I’m sorry, I can’t access my memory right now, so I don’t know what we talked about last time. If you remind me, I can pick up from there. I’ll remember it once you tell me."
  - note: search_memory with no query
- **medium (unset) / no cap / route-14 1** (routed): "I don’t have a note that mentions a search provider. I’ve checked the notebook and nothing was written down about it. If you want to add one, just let me know."
  - note: search_notes
- **medium (unset) / no cap / route-14 2** (routed): "I don’t have a note about a search provider."
  - note: search_notes
- **medium (unset) / no cap / route-15 1** (routed): "Got it. I’ll keep that in mind."
  - note: remember_preference, not save_note
- **medium (unset) / no cap / route-15 2** (misrouted): "Saved decision note 'Unit System Preference'. Ixa will respond using metric units for all measurements."
  - note: remember_preference, not save_note
- **medium (unset) / 4096 / long 1** (summarized): "I saved a note titled Backend Environment that backend runs in WSL two gaming PC, speech sidecars are started by harness, Qdrant and Ollama run Docker, and desktop client uses local network; note is long."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both running in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / 4096 / long 2** (summarized): "I saved a note titled “Backend environment details” summarizing that the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **medium (unset) / 4096 / long 3** (summarized): "I saved a note titled Backend environment details backend runs in WSL two on gaming PC, sidecars are started by harness, Qdrant and Ollama are in Docker, and desktop client connects over local network; long."
  - on disk: "The backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness itself, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network rather than loopback."
- **medium (unset) / 4096 / long 4** (summarized): "Saved note Backend environment: backend runs in WSL two on gaming PC, sidecars started by harness, Qdrant and Ollama run in Docker, desktop client uses local network; long, let me know if you want part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker. The desktop client connects over the local network rather than loopback."
- **medium (unset) / 4096 / long 5** (summarized): "I saved a note titled Backend Deployment Details. It says backend runs in WSL two on gaming PC, sidecars, Qdrant and Ollama in Docker, network. The note is; let me know if you want a part."
  - on disk: "The core backend service is executed inside Windows Subsystem for Linux version two on the gaming PC. This gives the process a Linux kernel, full networking stack, and access to the GPU via the WSL2 integration. The WSL2 instance is configured to share the host’s GPU resources, allowing the backend to leverage CUDA for heavy computations. All speech processing components—text‑to‑speech and speech‑to‑text—are launched automatically by the harness. The harness monitors the backend’s health and restarts sidecars if they crash. Each sidecar runs in its own lightweight container, isolated from the main backend process, but shares the same network namespace so they can communicate over localhost. The vector database Qdrant and the local language model server Ollama are both deployed as Docker containers. Qdrant runs on port 6333 and stores embeddings on a persistent volume mounted from the host. Ollama exposes a REST API on port 11434, serving the chosen model (e.g., Llama‑3‑70B) and handling inference requests from the backend. The desktop client does not connect via loopback; instead it reaches the backend over the local network using the PC’s LAN IP. This design allows the client to run on a separate workstation while still communicating with the backend on the gaming PC. The connection is secured with TLS and authenticated using a shared token."
- **medium (unset) / 4096 / long 6** (cut): ""
  - on disk: "The core backend service runs inside Windows Subsystem for Linux version two on the gaming PC. This gives it a Linux kernel environment while still sharing the host's hardware. Speech processing sidecars are launched automatically by the harness process. They are lightweight containers that handle TTS and STT, and they communicate with the backend over local sockets. Both Qdrant and Ollama are deployed as Docker containers on the same host. Qdrant stores the vector embeddings, while Ollama hosts the language model. The desktop client connects to the backend over the local network using the machine's LAN IP address, not via loopback. This allows multiple devices on the network to access the service."
- **medium (unset) / 4096 / long 7** (summarized): "I saved a note titled 'Backend Deployment Details' covering the backend in WSL two, harness‑started sidecars, Docker Qdrant and Ollama, and desktop client using local network. let me know if you want a section."
  - on disk: "The core backend service runs inside Windows Subsystem for Linux two on the gaming PC, giving it a native Linux environment while remaining accessible from Windows. The harness process automatically launches the speech sidecars, which handle synthesis and recognition. Both Qdrant, the vector database, and Ollama, the local language model host, are containerized and run in Docker, sharing the same Docker network as the backend. The desktop client connects to the backend over the local network using the PC’s LAN IP address, not via the loopback interface, allowing remote access from other devices on the same network."
- **medium (unset) / 4096 / long 8** (summarized): "I saved a note titled Details. Backend runs in WSL two on PC, Qdrant and Ollama are in Docker, and client uses local network. It's long, so let me know if you want a part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker, and the desktop client connects over the local network rather than loopback."
- **medium (unset) / 4096 / long 9** (summarized): "I saved a note Backend Deployment Details. It says backend runs in WSL two on gaming PC, speech sidecars are launched by harness, Qdrant and Ollama run in Docker, and desktop client uses local network."
  - on disk: "The backend runs inside Windows Subsystem for Linux two on the gaming PC. The speech sidecars are launched automatically by the harness process. Both Qdrant and Ollama are deployed as Docker containers. The desktop client connects to the backend over the local network, not via loopback, ensuring cross‑device communication."
- **medium (unset) / 4096 / long 10** (summarized): "I saved a note titled “Backend Deployment Details” summarizing that the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend runs inside Windows Subsystem for Linux two on the gaming PC. The speech sidecars are launched automatically by the harness process. Both Qdrant and Ollama services are containerized in Docker. The desktop client connects to the backend over the local network, not via loopback."
- **medium (unset) / 4096 / path 1** (verbatim): "I saved the note: The Ixa repo is at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repo is at slash home slash wyatt slash Projects slash ixa."
- **medium (unset) / 4096 / path 2** (verbatim): "I saved a note with the following body: The Ixa repository is located at slash home slash wyatt slash Projects slash ixa. The note is titled Ixa Repo Path and is stored as a fact."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **medium (unset) / 4096 / name 1** (verbatim): "I saved a note in my notebook. The owner of this machine is Wyatt Fisher. I will keep it and will not overwrite it unless you ask, can update it if you tell me to."
  - on disk: "The owner of this machine is Wyatt Fisher."
- **medium (unset) / 4096 / name 2** (verbatim): "I saved a note with the following content: The person who owns this machine is called Wyatt Fisher."
  - on disk: "The person who owns this machine is called Wyatt Fisher."
- **medium (unset) / 4096 / digits 1** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **medium (unset) / 4096 / digits 2** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **medium (unset) / 4096 / route-11 1** (routed): "Got it. I’ll keep that in mind."
  - note: remember_preference
- **medium (unset) / 4096 / route-11 2** (routed): "Got it. I’ll remember you like your coffee black."
  - note: remember_preference
- **medium (unset) / 4096 / route-12 1** (misrouted): "Got it."
  - note: save_note
- **medium (unset) / 4096 / route-12 2** (misrouted): "Got it, I’ll remember that the STT sidecar uses base.en, not small."
  - note: save_note
- **medium (unset) / 4096 / route-13 1** (routed): "I’m sorry, I can’t access my memory right now, so I don’t know what we discussed last time."
  - note: search_memory with no query
- **medium (unset) / 4096 / route-13 2** (routed): "I’m sorry, I can’t pull up our last conversation right now. Let me know what you’d like to revisit."
  - note: search_memory with no query
- **medium (unset) / 4096 / route-14 1** (routed): "I don’t have a note about a search provider. If you’d like me to search again or add a note, just let me know."
  - note: search_notes
- **medium (unset) / 4096 / route-14 2** (routed): "I don’t have a note about a search provider. My notes cover backend deployment and infrastructure. If you’d like me to look up something else, just let me know."
  - note: search_notes
- **medium (unset) / 4096 / route-15 1** (routed): "I have saved your preference to answer in metric units. From now on, all measurements will be in metric. Feel free to ask for conversions if needed."
  - note: remember_preference, not save_note
- **medium (unset) / 4096 / route-15 2** (misrouted): "I saved the note: Always answer in metric units. Always answer in metric units."
  - note: remember_preference, not save_note
- **low / no cap / long 1** (summarized): "I saved a long note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network instead of loopback. The note is long, so let me know if you want any part of it."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / no cap / long 2** (summarized): "I saved a note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / no cap / long 3** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates inside Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run as Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / no cap / long 4** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **low / no cap / long 5** (summarized): "I saved a long note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network rather than loopback. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **low / no cap / long 6** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker containers. The desktop client connects over the local network rather than loopback."
- **low / no cap / long 7** (summarized): "I saved a long note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network instead of loopback. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / no cap / long 8** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, speech sidecars start with the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / no cap / long 9** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are both in Docker, and the desktop client connects over the local network rather than loopback. The note is long, so let me know if you want a specific part."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker. The desktop client connects over the local network rather than loopback."
- **low / no cap / long 10** (summarized): "I saved a long note titled “Backend Runtime Details.” It says the backend runs in WSL two on the gaming PC, speech sidecars start with the harness, Qdrant and Ollama are in Docker, and the desktop client uses the local network."
  - on disk: "The backend runs in WSL two on the gaming PC. The speech sidecars are started by the harness itself. Qdrant and Ollama are both in Docker. The desktop client connects over the local network rather than loopback."
- **low / no cap / path 1** (verbatim): "I saved a note: The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **low / no cap / path 2** (verbatim): "I saved a note: The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **low / no cap / name 1** (verbatim): "I saved the note: The person who owns this machine is called Wyatt Fisher."
  - on disk: "The person who owns this machine is called Wyatt Fisher."
- **low / no cap / name 2** (verbatim): "Saved note: The person who owns this machine is called Wyatt Fisher. The person who owns this machine is called Wyatt Fisher."
  - on disk: "The person who owns this machine is called Wyatt Fisher."
- **low / no cap / digits 1** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **low / no cap / digits 2** (verbatim): "I saved the note. The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **low / no cap / route-11 1** (routed): "Got it, you like your coffee black."
  - note: remember_preference
- **low / no cap / route-11 2** (routed): "Got it. I’ll keep that in mind."
  - note: remember_preference
- **low / no cap / route-12 1** (misrouted): "Got it. The STT sidecar uses the base.en model, not the small one. I’ll keep that in mind for any future references. Let me know if you need anything else."
  - note: save_note
- **low / no cap / route-12 2** (misrouted): "Got it, the STT sidecar uses base.en, not small."
  - note: save_note
- **low / no cap / route-13 1** (routed): "I’m sorry, I can’t look up our previous conversation right now."
  - note: search_memory with no query
- **low / no cap / route-13 2** (routed): "I’m sorry, I can’t look up our last conversation right now."
  - note: search_memory with no query
- **low / no cap / route-14 1** (routed): "I don’t have a note that mentions a search provider."
  - note: search_notes
- **low / no cap / route-14 2** (routed): "I don’t have a note about a search provider."
  - note: search_notes
- **low / no cap / route-15 1** (routed): "Got it. I’ll use metric units in my responses."
  - note: remember_preference, not save_note
- **low / no cap / route-15 2** (routed): "Got it. I’ll use metric units from now on."
  - note: remember_preference, not save_note
- **low / 4096 / long 1** (summarized): "I saved a note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend operates inside Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Qdrant and Ollama each run in separate Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 2** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network instead of loopback. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 3** (summarized): "I saved a note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated by the harness process. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 4** (summarized): "I saved a note titled “Backend Architecture Note” that says the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 5** (summarized): "I saved a long note titled “Backend Architecture Note” that says the backend runs in WSL two on the gaming PC, speech sidecars start via the harness, Qdrant and Ollama run in Docker, and the desktop client uses the local network."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 6** (summarized): "I saved a long note titled “Backend Runtime Details.” It says the backend runs in WSL two on the gaming PC, the speech sidecars are started by the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network instead of loopback. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 7** (summarized): "I saved a long note titled “Backend Deployment Details.” It says the backend runs in WSL two on the gaming PC, speech sidecars start with the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are launched automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 8** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, speech sidecars start with the harness, Qdrant and Ollama are in Docker, and the desktop client uses the local network."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated by the harness process. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 9** (summarized): "I saved a note titled “Backend Deployment Details” that says the backend runs in WSL two on the gaming PC, speech sidecars start via the harness, Qdrant and Ollama are in Docker, and the desktop client connects over the local network. The note is long, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated automatically by the harness. Both Qdrant and Ollama run inside Docker containers. The desktop client communicates over the local network instead of using loopback."
- **low / 4096 / long 10** (summarized): "I saved a long note titled “Backend Runtime Details” that says the backend runs in WSL two on the gaming PC, speech sidecars are started by the harness, Qdrant and Ollama run in Docker, and the desktop client connects over the local network instead of loopback. The note is detailed, so let me know if you want a specific part."
  - on disk: "The backend operates within Windows Subsystem for Linux two on the gaming PC. Speech sidecars are initiated by the harness itself. Both Qdrant and Ollama run inside Docker containers. The desktop client connects over the local network instead of using loopback."
- **low / 4096 / path 1** (verbatim): "I saved the note. The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **low / 4096 / path 2** (verbatim): "I saved the note. The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
  - on disk: "The Ixa repository is located at slash home slash wyatt slash Projects slash ixa."
- **low / 4096 / name 1** (verbatim): "I saved the note. The person who owns this machine is called Wyatt Fisher."
  - on disk: "The person who owns this machine is called Wyatt Fisher."
- **low / 4096 / name 2** (verbatim): "I saved the note. The person who owns this machine is called Wyatt Fisher."
  - on disk: "The person who owns this machine is called Wyatt Fisher."
- **low / 4096 / digits 1** (verbatim): "I saved the note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **low / 4096 / digits 2** (verbatim): "I saved a note: The STT sidecar listens on port five thousand and two."
  - on disk: "The STT sidecar listens on port five thousand and two."
- **low / 4096 / route-11 1** (routed): "Got it. I’ll remember you like your coffee black. If you need anything else, just let me know."
  - note: remember_preference
- **low / 4096 / route-11 2** (routed): "Got it, you like your coffee black. I’ll keep that in mind for any future coffee suggestions. If you want to tweak it later, just let me know."
  - note: remember_preference
- **low / 4096 / route-12 1** (misrouted): "Got it. The STT sidecar uses the base.en model, not the small one. Let me know if you need anything else."
  - note: save_note
- **low / 4096 / route-12 2** (misrouted): "Got it. The STT sidecar uses base.en, not small. I’ll keep that in mind for any future setup or troubleshooting. Let me know if you need anything else."
  - note: save_note
- **low / 4096 / route-13 1** (routed): "I’m sorry, I can’t check our past conversation right now."
  - note: search_memory with no query
- **low / 4096 / route-13 2** (routed): "I’m sorry, I can’t look up our last conversation right now. If you tell me what you need, I’ll help you with it."
  - note: search_memory with no query
- **low / 4096 / route-14 1** (routed): "I don’t have a note about a search provider."
  - note: search_notes
- **low / 4096 / route-14 2** (routed): "I don’t have a note about a search provider."
  - note: search_notes
- **low / 4096 / route-15 1** (routed): "I’ve noted your preference to use metric units in all answers."
  - note: remember_preference, not save_note
- **low / 4096 / route-15 2** (routed): "I’ve noted that you want all answers in metric units. I’ll keep that in mind."
  - note: remember_preference, not save_note

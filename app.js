
// Engine Manager to handle Worker vs Main Thread complexity
class EngineManager {
    constructor(statusCallback, onReadyCallback, onMoveCallback) {
        this.statusCallback = statusCallback;
        this.onReadyCallback = onReadyCallback;
        this.onMoveCallback = onMoveCallback;

        this.engine = null;
        this.isWorker = false;
        this.isReady = false;

        this.init();
    }

    init() {
        this.statusCallback("Initializing Engine...");

        try {
            // Priority 1: Try Web Worker (Preferred)
            this.engine = new Worker('js/lib/stockfish.js');
            this.isWorker = true;

            this.engine.onmessage = (event) => this.handleMessage(event.data);
            this.engine.onerror = (e) => {
                console.warn("Worker failed, falling back to main thread:", e);
                this.switchToMainThread();
            };

            // Initialize UCI
            this.engine.postMessage('uci');

            // Safety timeout
            setTimeout(() => {
                if (!this.isReady && this.isWorker) {
                    console.warn("Worker timed out, switching to main thread.");
                    this.switchToMainThread();
                }
            }, 2000);

        } catch (e) {
            console.warn("Worker creation failed instantly:", e);
            this.switchToMainThread();
        }
    }

    switchToMainThread() {
        if (this.isWorker && this.engine) {
            this.engine.terminate();
            this.engine = null;
        }
        this.isWorker = false;

        this.statusCallback("Loading Main Thread Engine...");
        this.waitForStockfishModule();
    }

    waitForStockfishModule() {
        let attempts = 0;
        const check = setInterval(() => {
            attempts++;
            // Check if Module exists. Note: This specific build might NOT export ccall.
            // It often attaches to window.onmessage for input.
            if (typeof StockfishModule !== 'undefined' || (typeof Module !== 'undefined' && Module)) {
                clearInterval(check);
                this.initMainThread();
            } else if (attempts > 20) {
                clearInterval(check);
                this.statusCallback("Engine Load Failed (Random Moves Only)");
                console.error("StockfishModule not found.");
                alert("Error: No se pudo cargar el motor de ajedrez (Stockfish). Esto suele pasar en iOS si abres el archivo localmente debido a restricciones de seguridad. Prueba a alojarlo en un servidor web.");
            }
        }, 500);
    }

    initMainThread() {
        console.log("Initializing Main Thread Stockfish...");
        const self = this;

        // Listen for output via window message event (how asm.js stockfish often talks back)
        window.addEventListener('message', (e) => {
            // We need to filter messages because we might be sending OUR OWN messages via onmessage check below
            // Stockfish usually sends strings.
            if (typeof e.data === 'string') {
                self.handleMessage(e.data);
            }
        });

        // Send UCI command to start
        this.sendCommand('uci');
    }

    sendCommand(cmd) {
        if (!this.isReady && cmd !== 'uci') return;

        if (this.isWorker) {
            this.engine.postMessage(cmd);
        } else {
            // Main thread execution
            // Try ccall if available (WASM builds)
            if (typeof StockfishModule !== 'undefined' && StockfishModule.ccall) {
                StockfishModule.ccall('uci_command', 'number', ['string'], [cmd]);
            }
            // Fallback to window.onmessage (ASM.JS builds)
            else if (typeof window.onmessage === 'function') {
                window.onmessage({ data: cmd });
            }
            else {
                console.warn("No valid input channel for Stockfish Main Thread!");
            }
        }
    }

    handleMessage(line) {
        // console.log("Engine:", line);

        if (line === 'uciok') {
            // Avoid double-ready if we receive multiple messages
            if (!this.isReady) {
                this.isReady = true;
                this.statusCallback("Stockfish Ready " + (this.isWorker ? "(Worker)" : "(Main)"));
                this.onReadyCallback();
            }
        }

        if (line && line.startsWith('bestmove')) {
            const move = line.split(' ')[1];
            this.onMoveCallback(move);
        }
    }
}

class ChessApp {
    constructor() {
        this.game = new Chess();
        this.boardEl = document.getElementById('chessboard');
        this.statusEl = document.getElementById('game-status');
        this.engineStatusEl = document.getElementById('engine-status');
        this.levelSelect = document.getElementById('difficulty');

        this.playerColor = 'w';
        this.isThinking = false;

        // Drag state
        this.selectedSquare = null;
        this.isDragging = false;
        this.dragStartSquare = null;
        this.draggedVisual = null;

        // Initialize Engine
        this.engineMgr = new EngineManager(
            (status) => { this.engineStatusEl.innerText = status; },
            () => { console.log("Engine Ready!"); },
            (bestMove) => { this.handleAiMove(bestMove); }
        );

        this.init();
    }

    init() {
        this.renderBoard();
        this.updateStatus();

        // UI Controls
        document.getElementById('btn-new-game').addEventListener('click', () => this.newGame());
        document.getElementById('btn-undo').addEventListener('click', () => this.undoMove());

        window.addEventListener('resize', () => { }); // No-op, CSS handles it
    }

    newGame() {
        if (this.isThinking) return;
        this.game.reset();
        this.selectedSquare = null;
        this.renderBoard();
        this.updateStatus();
        this.engineMgr.sendCommand('stop');
        this.engineMgr.sendCommand('ucinewgame');
    }

    undoMove() {
        if (this.isThinking) return;
        this.game.undo();
        this.game.undo();
        this.renderBoard();
        this.updateStatus();
    }

    // --- Board Rendering & Interaction (Similar to before but cleaned) ---

    renderBoard() {
        this.boardEl.innerHTML = '';
        const board = this.game.board();

        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const squareDiv = document.createElement('div');
                const isLight = (row + col) % 2 === 0;
                squareDiv.className = `square ${isLight ? 'light' : 'dark'}`;

                const squareId = String.fromCharCode(97 + col) + (8 - row);
                squareDiv.dataset.square = squareId;

                if (this.selectedSquare === squareId) squareDiv.classList.add('highlight');

                // Highlight last move? (Optional, skipping for brevity)

                const piece = board[row][col];
                if (piece) {
                    const pieceDiv = document.createElement('div');
                    pieceDiv.className = 'piece';
                    pieceDiv.innerHTML = PIECES[piece.color + piece.type.toUpperCase()];
                    pieceDiv.setAttribute('draggable', 'false'); // Custom drag only

                    if (this.isDragging && this.dragStartSquare === squareId) {
                        pieceDiv.style.opacity = '0.3';
                    }
                    squareDiv.appendChild(pieceDiv);
                }

                // Event Listeners
                squareDiv.addEventListener('pointerdown', (e) => this.handlePointerDown(e, squareId));

                // Move hints
                if (this.selectedSquare && !this.isDragging) {
                    const moves = this.game.moves({ square: this.selectedSquare, verbose: true });
                    if (moves.find(m => m.to === squareId)) {
                        const hint = document.createElement('div');
                        hint.className = 'hint-dot';
                        squareDiv.appendChild(hint);
                    }
                }

                this.boardEl.appendChild(squareDiv);
            }
        }
    }

    handlePointerDown(e, square) {
        if (this.isThinking) return;

        // 1. Try to Move (Click-Click)
        if (this.selectedSquare && !this.isDragging) {
            const move = this.tryMove(this.selectedSquare, square);
            if (move) {
                this.selectedSquare = null;
                return;
            }
        }

        // 2. Select / Start Drag
        const piece = this.game.get(square);
        if (piece && piece.color === this.playerColor) {
            e.preventDefault();
            this.isDragging = true;
            this.dragStartSquare = square;
            this.selectedSquare = square;

            // Create Drag Visual
            const squareEl = this.boardEl.querySelector(`[data-square="${square}"]`);
            const pieceEl = squareEl.querySelector('.piece');
            if (pieceEl) {
                const rect = pieceEl.getBoundingClientRect();
                this.draggedVisual = pieceEl.cloneNode(true);
                Object.assign(this.draggedVisual.style, {
                    position: 'fixed', zIndex: 1000, pointerEvents: 'none',
                    width: rect.width + 'px', height: rect.height + 'px',
                    left: (e.clientX - rect.width / 2) + 'px', top: (e.clientY - rect.height / 2) + 'px'
                });
                this.draggedVisual.classList.add('dragging');
                document.body.appendChild(this.draggedVisual);

                // Global listeners
                this.dragMoveHandler = (ev) => this.handlePointerMove(ev);
                this.dragEndHandler = (ev) => this.handlePointerUp(ev);
                document.addEventListener('pointermove', this.dragMoveHandler);
                document.addEventListener('pointerup', this.dragEndHandler);
            }
            this.renderBoard();
        } else {
            this.selectedSquare = null;
            this.renderBoard();
        }
    }

    handlePointerMove(e) {
        if (!this.draggedVisual) return;
        e.preventDefault();
        const width = parseFloat(this.draggedVisual.style.width);
        const height = parseFloat(this.draggedVisual.style.height);
        this.draggedVisual.style.left = (e.clientX - width / 2) + 'px';
        this.draggedVisual.style.top = (e.clientY - height / 2) + 'px';
    }

    handlePointerUp(e) {
        this.isDragging = false;
        if (this.draggedVisual) {
            this.draggedVisual.remove();
            this.draggedVisual = null;
        }
        document.removeEventListener('pointermove', this.dragMoveHandler);
        document.removeEventListener('pointerup', this.dragEndHandler);

        // Find drop target
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        const squareEl = elements.find(el => el.classList.contains('square'));
        if (squareEl) {
            const target = squareEl.dataset.square;
            if (target !== this.dragStartSquare) {
                this.tryMove(this.dragStartSquare, target);
            }
        }
        this.renderBoard(); // Cleanup opacity
    }

    tryMove(from, to) {
        const move = this.game.move({ from, to, promotion: 'q' });
        if (move) {
            this.renderBoard();
            this.updateStatus();
            this.triggerAi();
            return true;
        }
        return false;
    }

    // --- AI Logic ---

    triggerAi() {
        if (this.game.game_over()) return;

        this.isThinking = true;
        this.statusEl.innerText = "AI is thinking...";

        const depth = parseInt(this.levelSelect.value) || 10;
        const fen = this.game.fen();

        // Send to Engine
        if (this.engineMgr.isReady) {
            this.engineMgr.sendCommand(`position fen ${fen}`);
            // Use movetime to prevent main thread freezing for too long (e.g. 60s).
            // 2500ms is a good balance for "strong but fast" in JS.
            // Stockfish will search as deep as possible within this time.
            const timeLimit = 2500;
            this.engineMgr.sendCommand(`go depth ${depth} movetime ${timeLimit}`);
        } else {
            // Fallback if engine purely crashed
            console.warn("Engine not ready, using pure random fallback");
            setTimeout(() => this.makeRandomMove(), 1000);
        }
    }

    handleAiMove(bestMove) {
        if (!this.isThinking) return; // Game reset or something?

        if (bestMove && bestMove !== '(none)') {
            const from = bestMove.substring(0, 2);
            const to = bestMove.substring(2, 4);
            const promotion = bestMove.substring(4, 5);

            this.game.move({ from, to, promotion });
            this.isThinking = false;
            this.renderBoard();
            this.updateStatus();
        } else {
            // Engine couldn't find a move (mate?)
            this.isThinking = false;
            this.updateStatus();
        }
    }

    makeRandomMove() {
        const moves = this.game.moves();
        if (moves.length > 0) {
            const mk = moves[Math.floor(Math.random() * moves.length)];
            this.game.move(mk);
        }
        this.isThinking = false;
        this.renderBoard();
        this.updateStatus();
    }

    updateStatus() {
        if (this.game.in_checkmate()) {
            this.statusEl.innerText = this.game.turn() === 'w' ? "Black Wins!" : "White Wins!";
        } else if (this.game.in_draw()) {
            this.statusEl.innerText = "Draw!";
        } else {
            this.statusEl.innerText = this.game.turn() === 'w' ? "Your Turn" : "AI Turn";
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new ChessApp();
});

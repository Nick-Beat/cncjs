import _ from 'lodash';
import ExpressionEvaluator from 'expr-eval';
import SerialPort from 'serialport';
import ensureArray from '../../lib/ensure-array';
import EventTrigger from '../../lib/event-trigger';
import Feeder from '../../lib/feeder';
import log from '../../lib/log';
import Sender, { SP_TYPE_SEND_RESPONSE } from '../../lib/sender';
import Workflow, {
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_IDLE
} from '../../lib/workflow';
import config from '../../services/configstore';
import monitor from '../../services/monitor';
import taskRunner from '../../services/taskrunner';
import store from '../../store';
import TinyG from './TinyG';
import {
    TINYG,
    TINYG_SERIAL_BUFFER_LIMIT,
    TINYG_PLANNER_BUFFER_LOW_WATER_MARK,
    TINYG_PLANNER_BUFFER_HIGH_WATER_MARK,
    TINYG_STATUS_CODES
} from './constants';

// Send Response State
const SEND_RESPONSE_STATE_NONE = 0;
const SEND_RESPONSE_STATE_SEND = 1;
const SEND_RESPONSE_STATE_ACK = 2;

const noop = () => {};

const dbg = (...args) => {
    log.raw.apply(log, ['silly'].concat(args));
};

const reExpressionContext = new RegExp(/\[[^\]]+\]/g);

class TinyGController {
    type = TINYG;

    // Connections
    connections = {};

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;
    serialportListener = {
        data: (data) => {
            this.tinyg.parse('' + data);
            dbg(`[TinyG] < ${data}`);
        },
        disconnect: (err) => {
            this.ready = false;
            if (err) {
                log.warn(`[TinyG] Disconnected from serial port "${this.options.port}":`, err);
            }

            this.close();
        },
        error: (err) => {
            this.ready = false;
            if (err) {
                log.error(`[TinyG] Unexpected error while reading/writing serial port "${this.options.port}":`, err);
            }
        }
    };

    // TinyG
    tinyg = null;
    ready = false;
    state = {};
    queryTimer = null;

    blocked = false;
    sendResponseState = SEND_RESPONSE_STATE_NONE;

    // Event Trigger
    event = null;

    // Feeder
    feeder = null;

    // Sender
    sender = null;

    // Workflow
    workflow = null;

    translateWithContext = (gcode, context = {}) => {
        if (typeof gcode !== 'string') {
            log.error(`[TinyG] No valid G-code string: gcode=${gcode}`);
            return '';
        }

        const { Parser } = ExpressionEvaluator;

        // Work position
        const { x: posx, y: posy, z: posz, a: posa, b: posb, c: posc } = this.tinyg.getWorkPosition();

        // Context
        context = {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
            zmin: 0,
            zmax: 0,
            ...context,

            // Work position cannot be overridden by context
            posx,
            posy,
            posz,
            posa,
            posb,
            posc
        };

        try {
            gcode = gcode.replace(reExpressionContext, (match) => {
                const expr = match.slice(1, -1);
                return Parser.evaluate(expr, context);
            });
        } catch (e) {
            log.error('[TinyG] translateWithContext:', e);
        }

        return gcode;
    };

    constructor(port, options) {
        const { baudrate } = { ...options };

        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // Event Trigger
        this.event = new EventTrigger((event, trigger, commands) => {
            log.debug(`[TinyG] EventTrigger: event="${event}", trigger="${trigger}", commands="${commands}"`);
            if (trigger === 'system') {
                taskRunner.run(commands);
            } else {
                this.command(null, 'gcode', commands);
            }
        });

        // Feeder
        this.feeder = new Feeder();
        this.feeder.on('data', (command = '', context = {}) => {
            if (this.isClose()) {
                log.error(`[TinyG] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.tinyg.isAlarm()) {
                // Feeder
                this.feeder.clear();
                log.warn('[TinyG] Stopped sending G-code commands in Alarm mode');
                return;
            }

            let line = String(command).trim();
            if (line.length === 0) {
                return;
            }

            // Example
            // "G0 X[posx - 8] Y[ymax]" -> "G0 X2 Y50"
            line = this.translateWithContext(line, context);

            this.emitAll('serialport:write', line);

            this.serialport.write(line + '\n');
            dbg(`[TinyG] > ${line}`);
        });

        // Sender
        this.sender = new Sender(SP_TYPE_SEND_RESPONSE);
        this.sender.on('data', (gcode = '', context = {}) => {
            if (this.isClose()) {
                log.error(`[TinyG] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.workflow.state !== WORKFLOW_STATE_RUNNING) {
                log.error(`[TinyG] Unexpected workflow state: ${this.workflow.state}`);
                return;
            }

            // Replace line numbers with the number of lines sent
            const n = this.sender.state.sent;
            gcode = ('' + gcode).replace(/^N[0-9]*/, '');
            gcode = ('N' + n + ' ' + gcode);

            // Remove blanks to reduce the amount of bandwidth
            gcode = ('' + gcode).replace(/\s+/g, '');

            this.serialport.write(gcode + '\n');
            dbg(`[TinyG] > SEND: n=${n}, gcode="${gcode}"`);
        });

        // Workflow
        this.workflow = new Workflow();
        this.workflow.on('start', () => {
            this.blocked = false;
            this.sendResponseState = SEND_RESPONSE_STATE_NONE;
            this.sender.rewind();
        });
        this.workflow.on('stop', () => {
            this.blocked = false;
            this.sendResponseState = SEND_RESPONSE_STATE_NONE;
            this.sender.rewind();
        });

        // TinyG
        this.tinyg = new TinyG();

        this.tinyg.on('raw', (res) => {
            if (this.workflow.state === WORKFLOW_STATE_IDLE) {
                this.emitAll('serialport:read', res.raw);
            }
        });

        // https://github.com/synthetos/g2/wiki/g2core-Communications
        this.tinyg.on('r', (r) => {
            if (this.workflow.state === WORKFLOW_STATE_IDLE) {
                this.feeder.next();
                return;
            }

            this.sendResponseState = SEND_RESPONSE_STATE_ACK; // ACK received

            const n = _.get(r, 'r.n') || _.get(r, 'n');
            const { sent } = this.sender.state;

            if (n !== sent) {
                log.error(`[TinyG] Assertion failed: n (${n}) is not equal to sent (${sent})`);
            }

            dbg(`[TinyG] < ACK: n=${n}, sent=${sent}, blocked=${this.blocked}`);

            // Continue to the next line if not blocked
            if (!this.blocked) {
                this.sender.ack();
                this.sender.next();
                this.sendResponseState = SEND_RESPONSE_STATE_SEND; // data sent
            }
        });

        this.tinyg.on('qr', ({ qr, qi, qo }) => {
            this.state.qr = qr;
            this.state.qi = qi;
            this.state.qo = qo;

            if (this.workflow.state === WORKFLOW_STATE_IDLE) {
                this.feeder.next();
                return;
            }

            if (qr <= TINYG_PLANNER_BUFFER_LOW_WATER_MARK) {
                this.blocked = true;
                return;
            }

            if (qr >= TINYG_PLANNER_BUFFER_HIGH_WATER_MARK) {
                this.blocked = false;
            }

            if ((this.workflow.state === WORKFLOW_STATE_RUNNING) && (this.sendResponseState === SEND_RESPONSE_STATE_ACK)) {
                dbg(`[TinyG] > NEXT: qr=${qr}, high=${TINYG_PLANNER_BUFFER_HIGH_WATER_MARK}, low=${TINYG_PLANNER_BUFFER_LOW_WATER_MARK}`);
                this.sender.ack();
                this.sender.next();
                this.sendResponseState = SEND_RESPONSE_STATE_SEND;
            }
        });

        this.tinyg.on('sr', (sr) => {
        });

        this.tinyg.on('fb', (fb) => {
        });

        this.tinyg.on('hp', (hp) => {
        });

        this.tinyg.on('f', (f) => {
            // https://github.com/synthetos/g2/wiki/Status-Codes
            const statusCode = f[1] || 0;

            if (statusCode !== 0) {
                const code = Number(statusCode);
                const err = _.find(TINYG_STATUS_CODES, { code: code }) || {};

                if (this.workflow.state !== WORKFLOW_STATE_IDLE) {
                    const { lines, received } = this.sender.state;
                    const line = lines[received] || '';

                    this.emitAll('serialport:read', `> ${line}`);
                    this.emitAll('serialport:read', JSON.stringify({
                        err: {
                            code: code,
                            msg: err.msg,
                            line: received + 1,
                            data: line.trim()
                        }
                    }));
                } else {
                    this.emitAll('serialport:read', JSON.stringify({
                        err: {
                            code: code,
                            msg: err.msg
                        }
                    }));
                }
            }

            if (this.workflow.state === WORKFLOW_STATE_IDLE) {
                this.feeder.next();
            }
        });

        // Timer
        this.queryTimer = setInterval(() => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            // Feeder
            if (this.feeder.peek()) {
                this.emitAll('feeder:status', this.feeder.toJSON());
            }

            // Sender
            if (this.sender.peek()) {
                this.emitAll('sender:status', this.sender.toJSON());
            }

            // TinyG state
            if (this.state !== this.tinyg.state) {
                this.state = this.tinyg.state;
                this.emitAll('TinyG:state', this.state);
            }
        }, 250);
    }
    // https://github.com/synthetos/TinyG/wiki/TinyG-Configuration-for-Firmware-Version-0.97
    initController() {
        const cmds = [
            // Wait for the bootloader to complete before sending commands
            { pauseAfter: 1000 },

            // Enable JSON mode
            // 0=text mode, 1=JSON mode
            { cmd: '{"ej":1}', pauseAfter: 50 },

            // JSON verbosity
            // 0=silent, 1=footer, 2=messages, 3=configs, 4=linenum, 5=verbose
            { cmd: '{"jv":4}', pauseAfter: 50 },

            // Queue report verbosity
            // 0=off, 1=filtered, 2=verbose
            { cmd: '{"qv":1}', pauseAfter: 50 },

            // Status report verbosity
            // 0=off, 1=filtered, 2=verbose
            { cmd: '{"sv":1}', pauseAfter: 50 },

            // Status report interval
            // in milliseconds (50ms minimum interval)
            { cmd: '{"si":250}', pauseAfter: 50 },

            // Setting Status Report Fields
            // https://github.com/synthetos/TinyG/wiki/TinyG-Status-Reports#setting-status-report-fields
            {
                // Minify the cmd string to ensure it won't exceed the serial buffer limit
                cmd: JSON.stringify({
                    sr: {
                        line: true,
                        vel: true,
                        feed: true,
                        stat: true,
                        cycs: true,
                        mots: true,
                        hold: true,
                        momo: true,
                        coor: true,
                        plan: true,
                        unit: true,
                        dist: true,
                        frmo: true,
                        path: true,
                        posx: true,
                        posy: true,
                        posz: true,
                        posa: true,
                        mpox: true,
                        mpoy: true,
                        mpoz: true,
                        mpoa: true
                    }
                }).replace(/"/g, '').replace(/true/g, 't'),
                pauseAfter: 50
            },

            // Hardware Platform
            { cmd: '{"hp":null}' },

            // Firmware Build
            { cmd: '{"fb":null}' },

            // Motor Timeout
            { cmd: '{"mt":null}' },

            // Request status report
            { cmd: '{"sr":null}' }
        ];

        const sendInitCommands = (i = 0) => {
            if (i >= cmds.length) {
                // Set ready flag to true after sending initialization commands
                this.ready = true;
                return;
            }
            const { cmd = '', pauseAfter = 0 } = { ...cmds[i] };
            if (cmd) {
                if (cmd.length >= TINYG_SERIAL_BUFFER_LIMIT) {
                    log.error(`[TinyG] Exceeded serial buffer limit (${TINYG_SERIAL_BUFFER_LIMIT}): cmd=${cmd}`);
                    return;
                }

                dbg(`[TinyG] > Init: ${cmd} ${cmd.length}`);
                this.emitAll('serialport:write', cmd);
                this.serialport.write(cmd + '\n');
            }
            setTimeout(() => {
                sendInitCommands(i + 1);
            }, pauseAfter);
        };
        sendInitCommands();
    }
    destroy() {
        this.connections = {};

        if (this.serialport) {
            this.serialport = null;
        }

        if (this.event) {
            this.event = null;
        }

        if (this.feeder) {
            this.feeder = null;
        }

        if (this.sender) {
            this.sender = null;
        }

        if (this.workflow) {
            this.workflow = null;
        }

        if (this.queryTimer) {
            clearInterval(this.queryTimer);
            this.queryTimer = null;
        }

        if (this.tinyg) {
            this.tinyg.removeAllListeners();
            this.tinyg = null;
        }
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: Object.keys(this.connections),
            ready: this.ready,
            controller: {
                type: this.type,
                state: this.state,
                ident: this.tinyg.ident,
                footer: this.tinyg.footer
            },
            workflowState: this.workflow.state,
            feeder: this.feeder.toJSON(),
            sender: this.sender.toJSON()
        };
    }
    open(callback = noop) {
        const { port, baudrate } = this.options;

        // Assertion check
        if (this.isOpen()) {
            log.error(`[TinyG] Cannot open serial port "${port}"`);
            return;
        }

        this.serialport = new SerialPort(this.options.port, {
            autoOpen: false,
            baudRate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });
        this.serialport.on('data', this.serialportListener.data);
        this.serialport.on('disconnect', this.serialportListener.disconnect);
        this.serialport.on('error', this.serialportListener.error);
        this.serialport.open((err) => {
            if (err) {
                log.error(`[TinyG] Error opening serial port "${port}":`, err);
                this.emitAll('serialport:error', { port: port });
                callback(err); // notify error
                return;
            }

            this.emitAll('serialport:open', {
                port: port,
                baudrate: baudrate,
                controllerType: this.type,
                inuse: true
            });

            callback(); // register controller

            log.debug(`[TinyG] Connected to serial port "${port}"`);

            this.workflow.stop();

            if (this.sender.state.gcode) {
                // Unload G-code
                this.command(null, 'unload');
            }

            // Initialize controller
            this.initController();
        });
    }
    close() {
        const { port } = this.options;

        // Assertion check
        if (!this.serialport) {
            log.error(`[TinyG] Serial port "${port}" is not available`);
            return;
        }

        // Stop status query
        this.ready = false;

        this.emitAll('serialport:close', {
            port: port,
            inuse: false
        });
        store.unset('controllers["' + port + '"]');

        if (this.isOpen()) {
            this.serialport.removeListener('data', this.serialportListener.data);
            this.serialport.removeListener('disconnect', this.serialportListener.disconnect);
            this.serialport.removeListener('error', this.serialportListener.error);
            this.serialport.close((err) => {
                if (err) {
                    log.error(`[TinyG] Error closing serial port "${port}":`, err);
                }
            });
        }

        this.destroy();
    }
    isOpen() {
        return this.serialport && this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        if (!socket) {
            log.error('[TinyG] The socket parameter is not specified');
            return;
        }

        log.debug(`[TinyG] Add socket connection: id=${socket.id}`);
        this.connections[socket.id] = socket;

        if (!_.isEmpty(this.state)) {
            // Send controller state to a newly connected client
            socket.emit('TinyG:state', this.state);
        }

        if (this.sender) {
            // Send sender status to a newly connected client
            socket.emit('sender:status', this.sender.toJSON());
        }
    }
    removeConnection(socket) {
        if (!socket) {
            log.error('[TinyG] The socket parameter is not specified');
            return;
        }

        log.debug(`[TinyG] Remove socket connection: id=${socket.id}`);
        this.connections[socket.id] = undefined;
        delete this.connections[socket.id];
    }
    emitAll(eventName, ...args) {
        Object.keys(this.connections).forEach(id => {
            const socket = this.connections[id];
            socket.emit.apply(socket, [eventName].concat(args));
        });
    }
    // https://github.com/synthetos/g2/wiki/Job-Exception-Handling
    // Character    Operation       Description
    // !            Feedhold        Start a feedhold. Ignored if already in a feedhold
    // ~            End Feedhold    Resume from feedhold. Ignored if not in feedhold
    // %            Queue Flush     Flush remaining moves during feedhold. Ignored if not in feedhold
    // ^d           Kill Job        Trigger ALARM to kill current job. Send {clear:n}, M2 or M30 to end ALARM state
    // ^x           Reset Board     Perform hardware reset to restart the board
    command(socket, cmd, ...args) {
        const handler = {
            'gcode:load': () => {
                let [name, gcode, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                // TODO: This will move to sender in a future release
                if (Object.keys(context).length > 0) {
                    // Example
                    // "G0 X[posx - 8] Y[ymax]" -> "G0 X2 Y50"
                    gcode = this.translateWithContext(gcode, context);
                }

                const ok = this.sender.load(name, gcode, context);
                if (!ok) {
                    callback(new Error(`Invalid G-code: name=${name}`));
                    return;
                }

                this.event.trigger('gcode:load');

                log.debug(`[TinyG] Load G-code: name="${this.sender.state.name}", size=${this.sender.state.gcode.length}, total=${this.sender.state.total}`);

                this.workflow.stop();

                callback(null, { name, gcode, context });
            },
            'gcode:unload': () => {
                this.workflow.stop();

                // Sender
                this.sender.unload();

                this.event.trigger('gcode:unload');
            },
            'start': () => {
                log.warn(`[TinyG] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:start');
            },
            'gcode:start': () => {
                this.event.trigger('gcode:start');

                this.workflow.start();

                // Feeder
                this.feeder.clear();

                // Sender
                this.sender.next();
            },
            'stop': () => {
                log.warn(`[TinyG] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:stop');
            },
            'gcode:stop': () => {
                this.event.trigger('gcode:stop');

                this.workflow.stop();

                this.writeln(socket, '!%'); // feedhold and queue flush

                setTimeout(() => {
                    this.writeln(socket, '{clear:null}');
                    this.writeln(socket, '{"qr":""}'); // queue report
                }, 250); // delay 250ms
            },
            'pause': () => {
                log.warn(`[TinyG] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:pause');
            },
            'gcode:pause': () => {
                this.event.trigger('gcode:pause');

                this.workflow.pause();
                this.writeln(socket, '!'); // feedhold
                this.writeln(socket, '{"qr":""}'); // queue report
            },
            'resume': () => {
                log.warn(`[TinyG] Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:resume');
            },
            'gcode:resume': () => {
                this.event.trigger('gcode:resume');

                this.writeln(socket, '~'); // cycle start
                this.writeln(socket, '{"qr":""}'); // queue report
                this.workflow.resume();
            },
            'feedhold': () => {
                this.event.trigger('feedhold');

                this.workflow.pause();
                this.writeln(socket, '!'); // feedhold
                this.writeln(socket, '{"qr":""}'); // queue report
            },
            'cyclestart': () => {
                this.event.trigger('cyclestart');

                this.writeln(socket, '~'); // cycle start
                this.writeln(socket, '{"qr":""}'); // queue report
                this.workflow.resume();
            },
            'statusreport': () => {
                this.writeln(socket, '{"sr":null}');
            },
            'homing': () => {
                this.event.trigger('homing');

                this.writeln(socket, '{home:1}');
            },
            'sleep': () => {
                this.event.trigger('sleep');

                // Not supported
            },
            'unlock': () => {
                this.writeln(socket, '{clear:null}');
            },
            'reset': () => {
                this.workflow.stop();

                // Feeder
                this.feeder.clear();

                this.write(socket, '\x18'); // ^x
            },
            'feedOverride': () => {
                // Not supported
            },
            'spindleOverride': () => {
                // Not supported
            },
            'rapidOverride': () => {
                // Not supported
            },
            'lasertest:on': () => {
                const [power = 0, duration = 0] = args;
                const commands = [
                    'M3S' + Math.abs(power)
                ];
                if (duration > 0) {
                    commands.push('G4P' + (duration / 1000));
                    commands.push('M5S0');
                }
                this.command(socket, 'gcode', commands);
            },
            'lasertest:off': () => {
                const commands = [
                    'M5S0'
                ];
                this.command(socket, 'gcode', commands);
            },
            'gcode': () => {
                const [commands, context] = args;
                const data = ensureArray(commands)
                    .join('\n')
                    .split('\n')
                    .filter(line => {
                        if (typeof line !== 'string') {
                            return false;
                        }

                        return line.trim().length > 0;
                    });

                this.feeder.feed(data, context);

                if (!this.feeder.isPending()) {
                    this.feeder.next();
                }
            },
            'macro:run': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[TinyG] Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:run');

                this.command(socket, 'gcode', macro.content, context);
                callback(null);
            },
            'macro:load': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[TinyG] Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:load');

                this.command(socket, 'gcode:load', macro.name, macro.content, context, callback);
            },
            'watchdir:load': () => {
                const [file, callback = noop] = args;
                const context = {}; // empty context

                monitor.readFile(file, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this.command(socket, 'gcode:load', file, data, context, callback);
                });
            }
        }[cmd];

        if (!handler) {
            log.error(`[TinyG] Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(socket, data) {
        // Assertion check
        if (this.isClose()) {
            log.error(`[TinyG] Serial port "${this.options.port}" is not accessible`);
            return;
        }

        this.emitAll('serialport:write', data);
        this.serialport.write(data);
        dbg(`[TinyG] > ${data}`);
    }
    writeln(socket, data) {
        this.write(socket, data + '\n');
    }
}

export default TinyGController;

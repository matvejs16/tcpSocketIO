import net from 'net';
import iconv from 'iconv-lite';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';

type ISocketListener = (socket: net.Socket, ...args: any[]) => void;
type ISocketAllListener = (socket: net.Socket, eventName: string, ...args: any[]) => void;
type ISocketConnectCallback = (socket: net.Socket) => void;
type ISocketDisconnectCallback = (socket: net.Socket, reason?: string) => void;

declare module 'net' {
    interface Socket {
        clientId: string;
        ping: number;
        travelTimeInterval: NodeJS.Timeout | undefined;
    }
}

const sendCallbackTimeout = 5000;
const splitter = '/5#$%^2+=/';
const splitterRegex = /\/5#\$%\^2\+=\//gm

class tcpSocketIO {
    private server: net.Server;
    private clients: Map<string, net.Socket> = new Map();
    private messagesCallbacks: Map<number, Function> = new Map();
    private listeners: Map<string, ISocketListener[]> = new Map();
    private allListeners: ISocketAllListener[] = [];
    private port: number;
    private host: string;
    private defaultEncoding: string;
    private devLog: boolean;
    private connectCallbacks: ISocketConnectCallback[] = [];
    private disconnectCallbacks: ISocketDisconnectCallback[] = [];

    constructor(port: number, host: string, defaultEncoding: string = 'utf8', devLog: boolean = false) {
        this.defaultEncoding = defaultEncoding;
        this.devLog = devLog;
        this.port = port;
        this.host = host;
        this.server = net.createServer();
    }

    private clientConnecHandler(socket: net.Socket) {
        let clientId = uuidv4();
        while (this.clients.has(clientId)) {
            clientId = uuidv4();
        }

        this.clients.set(clientId, socket);
        socket.clientId = clientId;
        socket.ping = -1;

        socket.travelTimeInterval = setInterval(() => {
            if (!this.clients.has(socket.clientId)) {
                clearInterval(socket.travelTimeInterval);
                return socket.travelTimeInterval = undefined;
            }
            const sendTime = process.hrtime()
            this.sendTo(socket.clientId, 'travelTime', () => {
                const travelTime = process.hrtime(sendTime);
                const travelTimeMs = travelTime[0] * 1000 + travelTime[1] / 1000000;
                socket.ping = travelTimeMs;
                console.log(chalk.cyan('[tcpSocketIO]'), `Client [${socket.clientId}] travel time: ${travelTimeMs}ms`);
            });
        }, 5000);

        this.connectCallbacks.forEach((callback) => {
            callback(socket);
        })
    }

    private clientDisconnecHandler(socket: net.Socket, reason?: string) {
        if (!this.clients.has(socket.clientId)) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Client [${socket.clientId}] is not connected`);
        this.disconnectCallbacks.forEach((callback) => {
            callback(socket, reason);
        })
        this.clients.delete(socket.clientId);
        socket.clientId = "";
        socket.ping = -1;

        if (socket.travelTimeInterval) {
            clearInterval(socket.travelTimeInterval);
            socket.travelTimeInterval = undefined;
        }
    }

    private messageHandler(socket: net.Socket, message: string) {
        // using regex to decode message
        const regex = /(\d+)(.*)/;
        const match = message.match(regex);
        if (!match) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error while decoding message from client [${socket.clientId}] | Message:`, message);
        const messageId = Number(match[1]);
        if (isNaN(messageId)) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error while decoding message from client [${socket.clientId}]: Message id is not a number`);
        const messageData = removeInvisibleSymbols(match[2].trim())
        let decodedMessage: any[];
        try {
            decodedMessage = JSON.parse(messageData);
            // console.log('MessageHandler:', messageId, decodedMessage)
            if (messageId > 0) {
                if (!this.messagesCallbacks.has(messageId)) return
                const callback = this.messagesCallbacks.get(messageId) as Function;
                callback(...decodedMessage);
                return this.messagesCallbacks.delete(messageId);
            }
            
            const eventName = decodedMessage.shift();
            if (eventName === 'ping') return this.sendTo(socket.clientId, 'pong');
            this.allListeners.forEach((listener) => {
                listener(socket, eventName, ...decodedMessage);
            })
            if (!this.listeners.has(eventName)) return
            this.listeners.get(eventName)?.forEach((listener) => {
                listener(socket, ...decodedMessage);
            })
        } catch (err) {
            return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error while decoding array from client [${socket.clientId}]: `, err, '| Message:', message);
        }
    }

    start(callback?: Function) {
        if (this.server.listening) return console.log(chalk.cyan('[tcpSocketIO]'), 'Server is already running');

        this.server.on('connection', (socket) => {
            this.clientConnecHandler(socket);
            if (this.devLog) console.log(chalk.cyan('[tcpSocketIO]'), 'Client connected: ', socket.remoteAddress, socket.remotePort, socket.clientId);

            socket.on('data', (data) => {
                const message = this.defaultEncoding === 'utf8' ? data.toString() : iconv.decode(data, this.defaultEncoding);
                const messages = message.split(splitterRegex);
                messages.forEach(async (thisMessage) => {
                    if (!thisMessage) return;
                    this.messageHandler(socket, thisMessage);
                })
            });

            socket.on('end', () => {
                if (this.devLog) console.log(chalk.cyan('[tcpSocketIO]'), 'Client disconnected: ', socket.remoteAddress, socket.remotePort, socket.clientId);
                this.clientDisconnecHandler(socket, 'end');
            })

            socket.on('error', (err) => {
                if (this.devLog) console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error from client [${socket.clientId}]: `, err);
                this.clientDisconnecHandler(socket, 'error');
            })
        })

        this.server.listen(this.port, this.host, () => {
            if (this.devLog) console.log(chalk.cyan('[tcpSocketIO]'), `Server is listening on host ${this.host} and port ${this.port}`);
            if (callback) callback();
        })
    }

    stop() {
        if (!this.server.listening) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), 'Server is not running');
        this.server.close();
        this.clients.clear();
        console.log(chalk.cyan('[tcpSocketIO]'), 'Server is stopped');
    }

    send(...message: any[]) {
        if (!this.server.listening) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), 'Server is not running');
        let arrStr = JSON.stringify(message);
        arrStr = `0${arrStr}${splitter}`
        const encodedMessage = this.defaultEncoding === 'utf8' ? arrStr : iconv.encode(arrStr, this.defaultEncoding);

        this.clients.forEach((client) => {
            client.write(encodedMessage, (err) => {
                if (err) console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error while sending message to client [${client.clientId}]: `, err)
            })
        })
    }

    sendTo(clientId: string, ...message: any[]) {
        if (!this.server.listening) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), 'Server is not running');
        let callback: Function | undefined;
        if (message[message.length - 1] instanceof Function) {
            callback = message.pop() as Function;
        }

        let arrStr = JSON.stringify(message);
        let messageId = callback ? randomNumber(0, 2147483647) : 0;
        while (messageId > 0 && this.messagesCallbacks.has(messageId)) {
            messageId = randomNumber(0, 2147483647);
        }
        arrStr = `${messageId}${arrStr}${splitter}`
        const encodedMessage = this.defaultEncoding === 'utf8' ? arrStr : iconv.encode(arrStr, this.defaultEncoding);

        if (!this.clients.has(clientId)) return console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Client [${clientId}] is not connected`);

        if (callback) {
            this.messagesCallbacks.set(messageId, callback);
            setTimeout(() => {
                if (!this.messagesCallbacks.has(messageId)) return;
                if (this.messagesCallbacks.get(messageId) !== callback) return;
                this.messagesCallbacks.delete(messageId);
            }, sendCallbackTimeout);
        }

        this.clients.get(clientId)?.write(encodedMessage, (err) => {
            if (!err) return;
            console.error(chalk.cyan('[tcpSocketIO]'), chalk.red('[ERROR]'), `Error while sending message to client [${clientId}]: `, err)
            if (callback) this.messagesCallbacks.delete(messageId);
        })
    }

    on(eventName: string, listener: ISocketListener) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
        this.listeners.get(eventName)?.push(listener);
    }

    once(eventName: string, listener: ISocketListener) {
        const onceListener: ISocketListener = (socket, ...args) => {
            this.off(eventName, onceListener);
            listener(socket, ...args);
        }
        this.on(eventName, onceListener);
    }

    onAllEvents(listener: ISocketAllListener) {
        this.allListeners.push(listener);
    }

    off(eventName: string, listener: ISocketListener) {
        if (!this.listeners.has(eventName)) return;
        const listeners = this.listeners.get(eventName) as ISocketListener[];
        const index = listeners.indexOf(listener);
        if (index === -1) return;
        listeners.splice(index, 1);
    }

    offAllEvents(listener: ISocketListener) {
        const index = this.allListeners.indexOf(listener);
        if (index === -1) return;
        this.allListeners.splice(index, 1);
    }

    offAll(eventName: string) {
        if (!this.listeners.has(eventName)) return;
        this.listeners.set(eventName, []);
    }

    offAllListeners() {
        this.listeners.clear();
    }

    getClients() {
        return this.clients;
    }

    getClient(clientId: string) {
        return this.clients.get(clientId);
    }

    onConnect(callback: ISocketConnectCallback) {
        this.connectCallbacks.push(callback);
    }

    onDisconnect(callback: ISocketDisconnectCallback) {
        this.disconnectCallbacks.push(callback);
    }
}

export default tcpSocketIO;

function randomNumber(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function removeInvisibleSymbols(str: string) {
    return str.replace(/\u0000/g, '');
}

// Example: 0["testEvent", 5333, true, false, "testEvent", "testData", "test, data", "test [string] with /special/ symbols"]/5#$%^2+=/
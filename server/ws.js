"use strict";

const http = require("http");

const WebSocket = require("ws");
const { auth } = require("os-npm-util");

const health = require("./health.js")

// TODO: Consul served over http..
const CONSUL_LEADER = auth.DOMAIN === "localhost"
    ? `http://localhost:8500`
    : `http://consul.${auth.DOMAIN}:8500`

// TODO: Maybe switch over to the npm consul or register handlers to listen
//   for changes to the cluster instead of sending GET requests.
// TODO: This works... for now
const CONSUL_API_IP = "172.17.0.1"
const CONSUL_API_PORT = "8500"

let root = {
    name: "Root",
    children: []
}

let datacenters = [];
let nodes = [];
let services = [];
let fetching = false;

// GENERAL NOTES:
// Connections are stored in this.wss.clients
// ws.upgradeReq.url === CLIENT "ROOM"

// Setup
let connectedPeers = [];
// More aggressive at start for testing purposes
const KEEP_ALIVE_INTERVAL = 1000 * 60 //60 seconds
const BROADCAST_INTERVAL = 1000 * 15 //15 seconds
const TTL = 3 // 3 sets of pings and no pong, you dead
const ROSTER_WS_PORT = 4001;

// TODO: Make functional, expose only necessary functions

module.exports = {
    init: function(opts) {
        let serverInit = typeof(opts) === "number"
            ? { port: opts }
            : { server: opts }
        this.wss = new WebSocket.Server(serverInit);
        this.registerGracefulShutdown(this.wss)
        this.wss.broadcast = (data) => {
            this.wss.clients.forEach((client) => {
                if(client.readyState === WebSocket.OPEN) {
                    this.canSendInfo(client, (canSend) => {
                         canSend && client.send(data);
                    })
                }
            });
        };
        this.registerEventHandlers();
        setInterval(this.startKeepAliveChecks.bind(this), KEEP_ALIVE_INTERVAL)
        // TODO: Turn into pub/sub model, only broadcast when changes happen vs checking on an interval
        setInterval(this.checkCenters.bind(this), BROADCAST_INTERVAL)
        console.log("WSS running");
        // RosterServer.init(ROSTER_WS_PORT);
        // health.registerListeners(RosterServer);
        // health.attachWSConnection(this.wss)

        this.checkCenters()
    },

    checkCenters: function () {
        this.fetchConsulInfo()
        .then(() => this.formTree(this.broadcastDataCenters.bind(this)))
        .catch((e) => {
            console.log("Problem fetching a: ", e);
        })
    },

    startKeepAliveChecks: function () {
        this.wss.clients.forEach((client) => {
            let clientId = client.upgradeReq.headers['sec-websocket-key'];
            this.canSend(client) && client.send(JSON.stringify({type: "ping"}))
            let peerInd = connectedPeers.findIndex((masterPeer) => masterPeer.wsId === clientId)
            let peer = connectedPeers[peerInd];
            peer && ++peer.pings && peer.pings > TTL && connectedPeers.splice(peerInd, 1)
        })
    },

    stilAlive: function (chatroom, evt, ws) {
        let wsId = ws.upgradeReq.headers['sec-websocket-key'];
        let peerInd = connectedPeers.findIndex((masterPeer) => masterPeer.wsId === wsId)
        connectedPeers[peerInd] && (connectedPeers[peerInd].pings = 0);
        // Inflates logs -- Good for testing
        // console.log(wsId+" sent pong");
    },

    registerEventHandlers: function() {
        this.wss.on("connection", (ws, req) => {
            ws.upgradeReq = req
            let wsId = ws.upgradeReq.headers['sec-websocket-key'];
            ws.send(JSON.stringify({type: "id", msg: wsId}))
            connectedPeers.push({wsId: wsId, pings: 0});
            console.log("Client Connected");

            ws.on('message', (evt) => {
                evt = JSON.parse(evt);
                let chatroom = ws.upgradeReq.url
                evt.type === "pong" && this.stilAlive(chatroom, evt, ws);
                evt.type === "auth" && this.addHeaders(chatroom, evt, ws);
                evt.type === "status" && this.getServerStatus(chatroom, evt, ws);
                evt.type === "services" && this.checkDataCenters(chatroom, evt, ws);
                evt.type === "updateCenters" && this.checkCenters();
                evt.type === "getLeader" && this.sendLeader(chatroom, evt, ws);
            })
            ws.on("close", (evt) => {
                let peerInd = connectedPeers.findIndex((masterPeer) => masterPeer.wsId === wsId)
                peerInd > -1 && connectedPeers.splice(peerInd, 1);
                console.log("Client closed. Clients in room after close evt: ", connectedPeers.length);
            })
        });
    },

    sendLeader: function(chatroom, evt, ws) {
        this.canSendInfo(ws, (canSend) => {
             canSend && ws.send(JSON.stringify({type: "getLeader", msg: CONSUL_LEADER}))
             !canSend && ws.send(JSON.stringify({type: "getLeader", msg: ""}))
        })
    },

    getServerStatus: function (chatroom, evt, ws) {
        health.getServerStatus((apps) => {
            let response = { type: "status", apps: apps }
            ws.send(JSON.stringify(response))
        })
    },

    canSend: function (ws) { return ws.readyState === 1 },

    addHeaders: function (chatroom, evt, ws) { ws.headers = evt.headers },

    canSendInfo: function (ws, callback) {
        this.checkAccess(ws.headers, "user", ({status}) => {
            let canSend = status && ws.readyState === 1
            callback(canSend)
        })
    },

    fetchConsulInfo() {
        if(fetching) { return Promise.reject("Already fetching") }
        fetching = true;
        return this.getDataCenters()
        .then((dcs) => {
            datacenters = dcs;
            let nodePromises = datacenters.map((dc) => this.getNodes(dc))
            return Promise.all(nodePromises)
        })
        .then((allNodes) => {
            nodes = allNodes.reduce((acc, val) => acc.concat(val))
            let concatNodes = allNodes.reduce((acc, val) => acc.concat(val))
            let servicePromises = concatNodes.map((node) => this.getServices(node.Node, node.Datacenter))
            return Promise.all(servicePromises)
        })
        .then((allServices) => {
            // We're trying to not allow serviceNode to be null
            // Most likely due to getting nodes from getNodes, but its being removed between getServices
            services = allServices.filter((service) => service !== null)
            let filteredServices = allServices.filter((service) => service !== null)
            nodes.forEach((node) => {
                let matchedServices = filteredServices.filter((serviceNode) => serviceNode.Node.ID === node.ID)[0].Services
                node.Services = Object.keys(matchedServices).length > 0
                    ? Object.keys(matchedServices).map((service) => {
                        let tag = matchedServices[service].Tags[0]
                        let tagIsVer = tag && tag.match(/\d{1,}\.\d{1,}\.\d{1,}/)
                        return {
                            name: service,
                            port: matchedServices[service].Port,
                            version: tagIsVer ? tag : ""
                        }
                      })
                    : []
            })
        })
        .then(() => {
            let checkPromises = nodes.map((node) => this.getChecks(node.Node, node.Datacenter))
            return Promise.all(checkPromises)
        })
        .then((allChecks) => {
            nodes.forEach((node) => {
                node.Checks = allChecks.filter((nodeChecks) =>
                    nodeChecks.every((check) => check.Node === node.Node)
                ).reduce((acc, val) => acc.concat(val))
            })
            fetching = false;
        })
        .catch((e) => { fetching = false; console.log("ERR - WS.FETCHCONSULINFO:\n", e) })
    },

    formTree(cb) {
        let children = []
        datacenters.forEach((dc, ind) => {
            let dcJson = { name: dc, children: [] }
            let filteredNodes = nodes.filter((node) => dc === node.Datacenter)
            filteredNodes.forEach((node, ind) => {
                let nodeJson = {
                    name: node.Node,
                    services: node.Services,
                    // .map((key) => { return { name: key, size: 1} }),
                    checks: node.Checks,
                    address: node.Address
                }
                dcJson.children.push(nodeJson)
            })
            children.push(dcJson)
        })
        root.children = children;
        cb();
    },

    // Used for tidy tree - not relevent with checks and services graph we're making now
    // formTree(cb) {
    //     let children = []
    //     datacenters.forEach((dc, ind) => {
    //         let dcJson = { name: dc, children: [] }
    //         let filteredNodes = nodes.filter((node) => dc === node.Datacenter)
    //         filteredNodes.forEach((node, ind) => {
    //             let nodeJson = {
    //                 name: node.Node,
    //                 children: node.Services.map((key) => { return { name: key, size: 1} })
    //             }
    //             dcJson.children.push(nodeJson)
    //         })
    //         children.push(dcJson)
    //     })
    //     root.children = children;
    //     cb();
    // },

    getDataCenters: function () {
        return new Promise((resolve, reject) => {
            this.sendGet("/v1/catalog/datacenters?stale", (err, dcs) => {
                if(err) { return reject(err) }
                resolve(dcs)
            })
        })
    },

    getNodes: function (dc) {
        return new Promise((resolve, reject) => {
            this.sendGet(`/v1/catalog/nodes?dc=${dc}&stale`, (err, machines) => {
                if(err) { return reject(err) }
                resolve(machines)
            })
        })
    },
    getServices: function (node, dc) {
        return new Promise((resolve, reject) => {
            this.sendGet(`/v1/catalog/node/${node}?dc=${dc}&stale`, (err, services) => {
                if(err) { return reject(err) }
                resolve(services)
            })
        })
    },
    getChecks: function (node, dc) {
        return new Promise((resolve, reject) => {
            this.sendGet(`/v1/health/node/${node}?dc=${dc}&stale`, (err, checks) => {
                if(err) { return reject(err) }
                resolve(checks)
            })
        })
    },

    broadcastDataCenters: function () {
        let response = { type: "services", root: root }
        this.wss.broadcast(JSON.stringify(response))
    },

    checkDataCenters: function (chatroom, evt, ws) {
        let response = { type: "services", root: root }
        let empty = { type: "services", root: { name: "Root", children: [] } }
        this.canSendInfo(ws, (canSend) => {
             canSend && ws.send(JSON.stringify(response))
             !canSend && ws.send(JSON.stringify(empty))
        })

    },

    sendGet: function (url, callback) {
        let opts = {
            method: "GET",
            port: CONSUL_API_PORT,
            path: `${url}`,
            hostname: CONSUL_API_IP
        }
        let response = "";
        let req = http.get(opts, (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                response += chunk.toString();
            });
            res.on('end', () => {
                try { callback(null, JSON.parse(response)) }
                catch(e) {
                    fetching = false;
                    console.log("ERR - WS.SENDGET:\n", JSON.stringify(opts));
                    callback(e)
                }
            });
        })
        req.on("error", (e) => { fetching = false; console.log("ERR:", e) })
    },

    checkAccess: function (headers, accessReq, callback) {
        auth.checkAccess({headers, app: "monitor", accessReq: accessReq})
        .then(({ status, hasPermissions }) => {
            if(!status) {
                console.log("User has incorrect authentication credentials");
                return callback({status: false})
            }
            if(!hasPermissions) {
                console.log("User does not have required access for action");
                return callback({status: false})
            }
            callback({status: true})
        })
        .catch((e) => { console.log("ERR - WS.CHECKACCESS:\n", e); callback({status: false}) })
    },


    registerGracefulShutdown: function(server) {
        let close = () => {
            console.log("Received SIG signal, shutting down");
            server.close(() => {
                console.log("Closed out all connections successfully");
                process.exit();
            })
        }
        process.on("SIGTERM", close)
        process.on("SIGHUP", close)
        process.on("SIGINT", close)
        process.on("SIGQUIT", close)
        process.on("SIGABRT", close)
    },

}

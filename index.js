"use strict";

// latest checked version of ioBroker.vw-connect: latest // https://github.com/TA2k/ioBroker.vw-connect/commit/604cdc1aacee0d13f189829aed985f35281f2016
var EventEmitter = require('events').EventEmitter;

const request = require("request");
const crypto = require("crypto");
const { Crypto } = require("@peculiar/webcrypto");
const { v4: uuidv4 } = require("uuid");
const traverse = require("traverse");
const express = require('express');
const mysql = require('mysql2');

module.exports.idStatusEmitter = new EventEmitter();
module.exports.idLogEmitter = new EventEmitter();

class Log {
    constructor(logLevel, external = false) {
        this.logLevel = logLevel;
        this.logTargetExternal = external;
        if (this.logTargetExternal) {
            module.exports.idLogEmitter.emit(this.logLevel, "Start logging instance");
        } else {
            this.debug("Start logging instance");
        }
    }
    setLogLevel(pLogLevel, pExternal = false) {
        this.logLevel = pLogLevel;
        this.logTargetExternal = pExternal;
    }
    debug(pMessage) {
        if (this.logLevel == "DEBUG") {
            if (this.logTargetExternal) {
            module.exports.idLogEmitter.emit("DEBUG", pMessage);
            } else {
                console.log("DEBUG: " + pMessage);
            }
        }
    }
    error(pMessage) {
        if (this.logLevel != "NONE") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("ERROR", pMessage);
            } else {
                console.log("ERROR: " + pMessage);
            }
        }
    }
    info(pMessage) {
        if (this.logLevel == "DEBUG" || this.logLevel == "INFO") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("INFO", pMessage);
            } else {
                console.log("INFO:  " + pMessage);
            }
        }
    }
    warn(pMessage) {
        if (this.logLevel == "DEBUG" || this.logLevel == "INFO" || this.logLevel == "WARN") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("WARN", pMessage);
            } else {
                console.log("WARN: " + pMessage);
            }
        }
    }
}

class VwWeConnect {
    config = {
        userid: 0,
        user: "testuser",
        password: "testpass",
        type: "id",
        interval: 10,
        forceinterval: 0,
        numberOfTrips: 1,
        logLevel: "ERROR",
        targetTempC: -1,
        targetSOC: -1,
        chargeCurrent: "maximum",
        autoUnlockPlug: false,
        climatizationAtUnlock: true,
        climatisationWindowHeating: true,
        climatisationFrontLeft: true,
        climatisationFrontRight: false,
        unSafe: false,
        noExternalPower: false,
        pendingRequests: 0,
        historyLimit: 100,
        chargerOnly: false,
        backendError: false,
    }

    currSession = {
        vin: "n/a"
    }

    constructor() {
        this.boolFinishIdData = false;
        this.boolFinishHomecharging = false;
        this.boolFinishChargeAndPay = false;
        this.boolFinishStations = false;
        this.boolFinishVehicles = false;
        this.boolFinishCarData = false;

        this.log = new Log(this.config.logLevel);
        this.jar = request.jar();
        this.userAgent = "ioBroker v47";

        this.refreshTokenInterval = null;
        this.vwrefreshTokenInterval = null;
        this.updateInterval = null;
        this.fupdateInterval = 0; // set force update interval to 0 => deactivated;
        this.refreshTokenTimeout = null;

        this.homeRegion = {};
        this.homeRegionSetter = {};

        this.vinArray = [];
        this.etags = {};

        this.statesArray = [
            {
                url: "$homeregion/fs-car/bs/departuretimer/v1/$type/$country/vehicles/$vin/timer",
                path: "timer",
                element: "timer",
            },
            {
                url: "$homeregion/fs-car/bs/climatisation/v1/$type/$country/vehicles/$vin/climater",
                path: "climater",
                element: "climater",
            },
            {
                url: "$homeregion/fs-car/bs/cf/v1/$type/$country/vehicles/$vin/position",
                path: "position",
                element: "storedPositionResponse",
                element2: "position",
                element3: "findCarResponse",
                element4: "Position",
            },
            {
                url: "$homeregion/fs-car/bs/tripstatistics/v1/$type/$country/vehicles/$vin/tripdata/$tripType?type=list",
                path: "tripdata",
                element: "tripDataList",
            },
            {
                url: "$homeregion/fs-car/bs/vsr/v1/$type/$country/vehicles/$vin/status",
                path: "status",
                element: "StoredVehicleDataResponse",
                element2: "vehicleData",
            },
            {
                url: "$homeregion/fs-car/destinationfeedservice/mydestinations/v1/$type/$country/vehicles/$vin/destinations",
                path: "destinations",
                element: "destinations",
            },
            {
                url: "$homeregion/fs-car/bs/batterycharge/v1/$type/$country/vehicles/$vin/charger",
                path: "charger",
                element: "charger",
            },
            {
                url: "$homeregion/fs-car/bs/rs/v1/$type/$country/vehicles/$vin/status",
                path: "remoteStandheizung",
                element: "statusResponse",
            },
            {
                url: "$homeregion/fs-car/bs/dwap/v1/$type/$country/vehicles/$vin/history",
                path: "history",
            },
        ];
    }

    finishedReading() {
        //  this.log.debug(" Id/SkodaE: " + this.boolFinishIdData +
        //                " HomeCharge: " + this.boolFinishHomecharging +
        //                " ChargePay: " + this.boolFinishChargeAndPay +
        //                 " Stat: " + this.boolFinishStations +
        //                 " Car: " + this.boolFinishCarData +
        //                 " Vehic: " + this.boolFinishVehicles);
        return (this.boolFinishIdData || this.config.chargerOnly)
            //          && this.boolFinishHomecharging
            //          && this.boolFinishChargeAndPay
            //          && this.boolFinishStations
            /*&& this.boolFinishCarData*/
            && this.boolFinishVehicles;
    }

    setCredentials(pUser, pPass) {
        //this.config.userid = 0;
        this.config.user = pUser;
        this.config.password = pPass;
        //this.config.type = "id";
        this.config.interval = 0.5;
        this.config.checkSafeStatusTimeout = 5; // minutes to wait for event if car is not locked or windows not closed
        //this.config.forceinterval = 360; // shouldn't be smaller than 360mins, default 0 (off)
        //this.config.numberOfTrips = 1;
    }

    setConfig(pType) {
        if (pType == "idCharger") {
            this.config.type = "id";
            this.config.chargerOnly = true;
        }
        else {
            this.config.type = pType;
        }
    }

    setHistoryLimit(pLimit) {
        this.config.historyLimit = pLimit;
    }

    setActiveVin(pVin) {
        if (this.vinArray.includes(pVin)) {
            this.currSession.vin = pVin;
            this.log.info("Active VIN successfully set to <" + this.currSession.vin + ">.");
        } else {
            this.log.error("VIN <" + pVin + "> is unknown. Active VIN is still <" + this.currSession.vin + ">.");
        }
    }

    setDatabase(pHost) {
        this.config.db = mysql.createPool({
          host: pHost,      // your MySQL host
          user: this.config.user,         // your DB username
          password: this.config.password, // your DB password
          database: 'weconnect',       // your DB name
          waitForConnections: true,
          connectionLimit: 10,
});
    }

    restart() {
        // dummy
    }

    stopCharging() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("stopCharging >>");
            this.setIdRemote(this.currSession.vin, "charging", "stop", "")
                .then(() => {
                    this.log.debug("stopCharging successful");
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("stopCharging failed");
                    reject(error);
                    return;
                });
            this.log.debug("stopCharging <<");
        });
    }

    setChargingSetting(setting, value) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setChargerSetting " + setting + " to " + value + " >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }

            switch (setting) {
                case "targetSOC":
                    if (value >= 50 && value <= 100) {
                        this.config.pendingRequests++;
                        this.config.targetSOC = value;
                    } else {
                        this.log.debug("setChargerSetting " + setting + " value " + value + " out of bounds >>");
                    }
                    break;
                case "chargeCurrent":
                    if (value == "maximum" || value == "reduced") {
                        this.config.pendingRequests++;
                        this.config.chargeCurrent = value;
                    } else {
                        this.log.debug("setChargerSetting " + setting + " incorrect value " + value + "  >>");
                    }
                    break;
                case "autoUnlockPlug":
                    this.config.pendingRequests++;
                    this.config.autoUnlockPlug = value;
                    break;
                default:
                    this.log.debug("setChargerSetting " + setting + " not implemented" + " >>");
                    break;
            }

            this.setIdRemote(this.currSession.vin, "charging", "settings")
                .then(() => {
                    this.log.info("setIdRemote succeeded");
                    this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("setIdRemote failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                    return;
                });
            this.log.debug("setChargerSettings <<");
        });
    }

    setChargingSettings(pTargetSOC, pChargeCurrent) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setChargerSettings TargetSOC to " + pTargetSOC + "%, chargeCurrent to " + pChargeCurrent + " >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }
            if (pTargetSOC >= 50 && pTargetSOC <= 100) {
                this.config.pendingRequests++;
                this.config.targetSOC = pTargetSOC;
            }
            if (pChargeCurrent == "maximum" || pChargeCurrent == "reduced") {
                this.config.pendingRequests++;
                this.config.chargeCurrent = pChargeCurrent;
            }

            this.setIdRemote(this.currSession.vin, "charging", "settings")
                .then(() => {
                    this.log.info("Target SOC set to " + this.config.targetSOC + "%.");
                    this.log.info("Charging current set to " + this.config.chargeCurrent + ".");
                    this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("setting SOC and charge current failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                    return;
                });
            this.log.debug("setChargerSettings <<");
        });
    }

    startCharging() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("startCharging >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }

            this.setIdRemote(this.currSession.vin, "charging", "start")
                .then(() => {
                    this.log.debug("startCharging successful");
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("startCharging failed");
                    reject(error);
                    return;
                });

            this.log.debug("startCharging <<");
        });
    }

    stopClimatisation() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("stopClimatisation >>");
            this.setIdRemote(this.currSession.vin, "climatisation", "stop", "")
                .then(() => {
                    this.log.debug("stopClimatisation successful");
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("stopClimatisation failed");
                    reject(error);
                    return;
                });
            this.log.debug("stopClimatisation <<");
        });
    }

    setDestination(destination) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setDestination >>");
            this.setIdRemote(this.currSession.vin, "destinations", "", destination)
                .then(() => {
                    this.log.debug("setDestination successful");
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("setDestination failed");
                    reject(error);
                    return;
                });
            this.log.debug("setDestination <<");
        });
    }

    startClimatisation() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("startClimatisation with " + this.config.targetTempC + "°C >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }

            this.setIdRemote(this.currSession.vin, "climatisation", "start", "")
                .then(() => {
                    this.log.debug("startClimatisation successful");
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("startClimatisation failed");
                    reject(error);
                    return;
                });
            this.log.debug("startClimatisation <<");
        });
    }

    setClimatisationSetting(pSetting, pValue) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setClimatisationSetting with " + pSetting + " " + pValue + " >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }

            this.config.pendingRequests++;
            switch (pSetting) {
                case "climatizationAtUnlock": this.config.climatizationAtUnlock = pValue; break;
                case "climatisationWindowHeating": this.config.climatisationWindowHeating = pValue; break;
                case "climatisationFrontLeft": this.config.climatisationFrontLeft = pValue; break;
                case "climatisationFrontRight": this.config.climatisationFrontRight = pValue; break;
                default: break;
            }

            this.setIdRemote(this.currSession.vin, "climatisation", "settings", "")
                .then(() => {
                    this.log.debug("setClimatisationSetting successful");
                    this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("setClimatisationSetting failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                    return;
                });
            this.log.debug("setClimatisationSetting <<");
        });
    }

    setClimatisation(pTempC) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setClimatisation with " + pTempC + "°C >>");
            if (!this.finishedReading()) {
                this.log.info("Reading necessary data not finished yet. Please try again.");
                reject(err);
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error("Unknown VIN, aborting. Use setActiveVin to set a valid VIN.");
                reject(err);
                return;
            }
            if (pTempC < 16 || pTempC > 27) {
                this.log.info("Invalid temperature, setting 20°C as default");
                pTempC = 20;
            }
            this.config.pendingRequests++;
            this.config.targetTempC = pTempC;

            this.setIdRemote(this.currSession.vin, "climatisation", "settings", "")
                .then(() => {
                    this.log.debug("setClimatisation successful");
                    this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
                    resolve();
                    return;
                })
                .catch((error) => {
                    this.log.error("setClimatisation failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                    return;
                });
            this.log.debug("setClimatisation <<");
        });
    }

    // logLevel: ERROR, INFO, DEBUG
    setLogLevel(pLogLevel, pExternal = false) {
        this.log.setLogLevel(pLogLevel, pExternal);
    }

    enableApi(port) {
        const app = express();
        app.get('/status', (req, res) => {
            if (typeof(this.idData) != "undefined") {
                res.json(this.idData);
            } else {
                res.status(200).end();
            }
        });

        app.listen(port, () => {
            this.log.info(`API server is running on port ${port}`);
        });
    }

    async getData() {
        this.boolFinishIdData = false;
        this.boolFinishHomecharging = false;
        this.boolFinishChargeAndPay = false;
        this.boolFinishStations = false;
        this.boolFinishVehicles = false;
        this.boolFinishCarData = false;

        // resolve only after all the different calls have finished reading their data
        // await promise at the end of this method
        let promise = new Promise((resolve, reject) => {
            const finishedReadingInterval = setInterval(() => {
                if (this.finishedReading()) {
                    clearInterval(finishedReadingInterval)
                    resolve("done!");
                } else {
                }
            }, 1000)
        });

        // Reset the connection indicator during startup
        //         this.type = "VW";
        //         this.country = "DE";
        //         this.clientId = "9496332b-ea03-4091-a224-8c746b885068%40apps_vw-dilab_com";
        //         this.xclientId = "38761134-34d0-41f3-9a73-c4be88d7d337";
        //         this.scope = "openid%20profile%20mbb%20email%20cars%20birthdate%20badge%20address%20vin";
        //         this.redirect = "carnet%3A%2F%2Fidentity-kit%2Flogin";
        //         this.xrequest = "de.volkswagen.carnet.eu.eremote";
        //         this.responseType = "id_token%20token%20code";
        //         this.xappversion = "5.1.2";
        //         this.xappname = "eRemote";

        this.type = "Id";
        this.country = "DE";
        this.clientId = "a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com";
        this.xclientId = "";
        this.scope = "openid profile badge cars dealers birthdate vin";
        this.redirect = "weconnect://authenticated";
        this.xrequest = "com.volkswagen.weconnect";
        this.responseType = "code id_token token";
        this.xappversion = "";
        this.xappname = "";

        if (this.config.interval === 0) {
            this.log.info("Interval of 0 is not allowed reset to 1");
            this.config.interval = 1;
        }
        this.tripTypes = [];
        if (this.config.tripShortTerm == true) {
            this.tripTypes.push("shortTerm");
        }
        if (this.config.tripLongTerm == true) {
            this.tripTypes.push("longTerm");
        }
        if (this.config.tripCyclic == true) {
            this.tripTypes.push("cyclic");
        }
        this.login()
            .then(() => {
                this.log.debug("Login successful");
                this.getPersonalData()
                    .then(() => {
                        this.getVehicles()
                            .then(() => {
                                this.vinArray.forEach((vin) => {
                                    this.getIdStatus(vin).catch((err) => {
                                         this.log.error("get id status Failed");
                                    });
                                });

                                this.updateInterval = setInterval(() => {
                                    this.updateStatus();
                                },
                                    this.config.interval * 60 * 1000);
                            })
                            .catch((err) => {
                                this.log.error("Get Vehicles Failed");
                            });
                    })
                    .catch((err) => {
                        this.log.error("get personal data Failed");
                    });
            })
            .catch((err) => {
                this.log.error("Login Failed");
            });

        let result = await promise; // wait for the promise from the start to resolve
        this.log.debug("getData END");
    }

    login() {
        return new Promise(async (resolve, reject) => {
            const nonce = this.getNonce();
            const state = uuidv4();

            let [code_verifier, codeChallenge] = this.getCodeChallenge();

            const method = "GET";
            const form = {};
            let url =
                "https://identity.vwgroup.io/oidc/v1/authorize?client_id=" +
                this.clientId +
                "&scope=" +
                this.scope +
                "&response_type=" +
                this.responseType +
                "&redirect_uri=" +
                this.redirect +
                "&nonce=" +
                nonce +
                "&state=" +
                state;

            if (this.config.type === "id" && this.type !== "Wc") {
                url = await this.receiveLoginUrl().catch((err) => {
                    this.log.warn("Failed to get login url");
                });
                if (!url) {
                    url = "https://emea.bff.cariad.digital/user-login/v1/authorize?nonce=" + this.randomString(16) + "&redirect_uri=weconnect://authenticated";
                }
            }
            const loginRequest = request(
                {
                    method: method,
                    url: url,
                    headers: {
                        "User-Agent": this.userAgent,
                        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept-Encoding": "gzip, deflate",
                        "x-requested-with": this.xrequest,
                        "upgrade-insecure-requests": 1,
                    },
                    jar: this.jar,
                    form: form,
                    gzip: true,
                    followAllRedirects: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (this.type === "Wc") {
                            if (err && err.message === "Invalid protocol: wecharge:") {
                                this.log.debug("Found WeCharge connection");
                                this.getTokens(loginRequest, code_verifier, reject, resolve);
                            } else {
                                this.log.debug("No WeCharge found, cancel login");
                                resolve();
                            }
                            return;
                        }
                        if (err && err.message.indexOf("Invalid protocol:") !== -1) {
                            this.log.debug("Found Token");
                            this.getTokens(loginRequest, code_verifier, reject, resolve);
                            return;
                        }
                        this.log.error("Failed in first login step ");
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        err && err.message && this.log.error(err.message);

                        loginRequest && loginRequest.uri && loginRequest.uri.query && this.log.debug(loginRequest.uri.query.toString());

                        reject(err);
                        return;
                    }

                    try {
                        let form = {};
                        if (body.indexOf("emailPasswordForm") !== -1) {
                            this.log.debug("parseEmailForm");
                            form = this.extractHidden(body);
                            form["email"] = this.config.user;
                        } else {
                            this.log.error("No Login Form found for type: " + this.type);
                            this.log.debug(JSON.stringify(body));
                            reject(err);
                            return;
                        }
                        request.post(
                            {
                                url: "https://identity.vwgroup.io/signin-service/v1/" + this.clientId + "/login/identifier",
                                headers: {
                                    "Content-Type": "application/x-www-form-urlencoded",
                                    "User-Agent": this.userAgent,
                                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                    "Accept-Language": "en-US,en;q=0.9",
                                    "Accept-Encoding": "gzip, deflate",
                                    "x-requested-with": this.xrequest,
                                },
                                form: form,
                                jar: this.jar,
                                gzip: true,
                                followAllRedirects: true,
                            },
                            (err, resp, body) => {
                                if (err || (resp && resp.statusCode >= 400)) {
                                    this.log.error("Failed to get login identifier");
                                    err && this.log.error(err);
                                    resp && this.log.error(resp.statusCode.toString());
                                    body && this.log.error(JSON.stringify(body));
                                    reject(err);
                                    return;
                                }
                                try {
                                    if (body.indexOf("emailPasswordForm") !== -1) {
                                        this.log.debug("emailPasswordForm2");
                                        /*
                                        const stringJson =body.split("window._IDK = ")[1].split(";")[0].replace(/\n/g, "")
                                        const json =stringJson.replace(/(['"])?([a-z0-9A-Z_]+)(['"])?:/g, '"$2": ').replace(/'/g, '"')
                                        const jsonObj = JSON.parse(json);
                                        */
                                        form = {
                                            _csrf: body.split("csrf_token: '")[1].split("'")[0],
                                            email: this.config.user,
                                            password: this.config.password,
                                            hmac: body.split('"hmac":"')[1].split('"')[0],
                                            relayState: body.split('"relayState":"')[1].split('"')[0],
                                        };
                                    } else {
                                        this.log.error("No Login Form found. Please check your E-Mail in the app.");
                                        this.log.debug(JSON.stringify(body));
                                        reject(err);
                                        return;
                                    }
                                    request.post(
                                        {
                                            url: "https://identity.vwgroup.io/signin-service/v1/" + this.clientId + "/login/authenticate",
                                            headers: {
                                                "Content-Type": "application/x-www-form-urlencoded",
                                                "User-Agent": this.userAgent,
                                                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                                "Accept-Language": "en-US,en;q=0.9",
                                                "Accept-Encoding": "gzip, deflate",
                                                "x-requested-with": this.xrequest,
                                            },
                                            form: form,
                                            jar: this.jar,
                                            gzip: true,
                                            followAllRedirects: false,
                                        },
                                        (err, resp, body) => {
                                            if (err || (resp && resp.statusCode >= 400)) {
                                                this.log.error("Failed to get login authenticate");
                                                err && this.log.error(err);
                                                resp && this.log.error(resp.statusCode.toString());
                                                body && this.log.error(JSON.stringify(body));
                                                reject(err);
                                                return;
                                            }

                                            try {
                                                this.log.debug(JSON.stringify(body));
                                                this.log.debug(JSON.stringify(resp.headers));

                                                if (resp.headers.location.split("&").length <= 2 || resp.headers.location.indexOf("/terms-and-conditions?") !== -1) {
                                                    this.log.warn(resp.headers.location);
                                                    this.log.warn("No valid userid, please visit this link or logout and login in your app account:");
                                                    this.log.warn("https://" + resp.request.host + resp.headers.location);
                                                    this.log.warn("Try to auto accept new consent");

                                                    request.get(
                                                        {
                                                            url: "https://" + resp.request.host + resp.headers.location,
                                                            jar: this.jar,
                                                            headers: {
                                                                "User-Agent": this.userAgent,
                                                                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                                                "Accept-Language": "en-US,en;q=0.9",
                                                                "Accept-Encoding": "gzip, deflate",
                                                                "x-requested-with": this.xrequest,
                                                            },
                                                            followAllRedirects: true,
                                                            gzip: true,
                                                        },
                                                        (err, resp, body) => {
                                                            this.log.debug(body);

                                                            const form = this.extractHidden(body);
                                                            const url = "https://" + resp.request.host + resp.req.path.split("?")[0];
                                                            this.log.debug(JSON.stringify(form));

                                                            request.post(
                                                                {
                                                                    url: url,
                                                                    jar: this.jar,
                                                                    headers: {
                                                                        "Content-Type": "application/x-www-form-urlencoded",
                                                                        "User-Agent": this.userAgent,
                                                                        Accept:
                                                                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                                                        "Accept-Language": "en-US,en;q=0.9",
                                                                        "Accept-Encoding": "gzip, deflate",
                                                                        "x-requested-with": this.xrequest,
                                                                    },
                                                                    form: form,
                                                                    followAllRedirects: true,
                                                                    gzip: true,
                                                                },
                                                                (err, resp, body) => {
                                                                    if ((err && err.message.indexOf("Invalid protocol:") !== -1) || (resp && resp.statusCode >= 400)) {
                                                                        this.log.warn("Failed to auto accept");
                                                                        err && this.log.error(err);
                                                                        resp && this.log.error(resp.statusCode.toString());
                                                                        body && this.log.error(JSON.stringify(body));
                                                                        reject(err);
                                                                        return;
                                                                    }
                                                                    this.log.info("Auto accept succesful. Restart adapter in 10sec");
                                                                    setTimeout(() => {
                                                                        this.restart();
                                                                    }, 10 * 1000);
                                                                }
                                                            );
                                                        }
                                                    );

                                                    reject(err);
                                                    return;
                                                }
                                                this.config.userid = resp.headers.location.split("&")[2].split("=")[1];
                                                if (!this.stringIsAValidUrl(resp.headers.location)) {
                                                    if (resp.headers.location.indexOf("&error=") !== -1) {
                                                        const location = resp.headers.location;
                                                        this.log.error("Error: " + location.substring(location.indexOf("error="), location.length - 1));
                                                    } else {
                                                        this.log.error("No valid login url, please download the log and visit:");
                                                        this.log.error("http://" + resp.request.host + resp.headers.location);
                                                    }
                                                    reject(err);
                                                    return;
                                                }

                                                let getRequest = request.get(
                                                    {
                                                        url: resp.headers.location || "",
                                                        headers: {
                                                            "User-Agent": this.userAgent,
                                                            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                                            "Accept-Language": "en-US,en;q=0.9",
                                                            "Accept-Encoding": "gzip, deflate",
                                                            "x-requested-with": this.xrequest,
                                                        },
                                                        jar: this.jar,
                                                        gzip: true,
                                                        followAllRedirects: true,
                                                    },
                                                    (err, resp, body) => {
                                                        if (err) {
                                                            this.log.debug(err);
                                                            this.getTokens(getRequest, code_verifier, reject, resolve);
                                                        } else {
                                                            this.log.debug(body);
                                                            this.log.debug("No Token received visiting url and accept the permissions.");
                                                            const form = this.extractHidden(body);
                                                            getRequest = request.post(
                                                                {
                                                                    url: getRequest.uri.href,
                                                                    headers: {
                                                                        "Content-Type": "application/x-www-form-urlencoded",
                                                                        "User-Agent": this.userAgent,
                                                                        Accept:
                                                                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
                                                                        "Accept-Language": "en-US,en;q=0.9",
                                                                        "Accept-Encoding": "gzip, deflate",
                                                                        "x-requested-with": this.xrequest,
                                                                        referer: getRequest.uri.href,
                                                                    },
                                                                    form: form,
                                                                    jar: this.jar,
                                                                    gzip: true,
                                                                    followAllRedirects: true,
                                                                },
                                                                (err, resp, body) => {
                                                                    if (err) {
                                                                        this.getTokens(getRequest, code_verifier, reject, resolve);
                                                                    } else {
                                                                        this.log.error("No Token received. Please try to logout and login in the VW app or select type VWv2 in the settings");
                                                                        try {
                                                                            this.log.debug(JSON.stringify(body));
                                                                        } catch (err) {
                                                                            this.log.error(err);
                                                                            reject(err);
                                                                        }
                                                                    }
                                                                }
                                                            );
                                                        }
                                                    }
                                                );
                                            } catch (err2) {
                                                this.log.error("Login was not successful, please check your login credentials and selected type");
                                                err && this.log.error(err);
                                                this.log.error(err2);
                                                this.log.error(err2.stack);
                                                reject(err);
                                            }
                                        }
                                    );
                                } catch (err) {
                                    this.log.error(err);
                                    reject(err);
                                }
                            }
                        );
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    updateStatus() {
        this.vinArray.forEach((vin) => {
            if (vin === this.currSession.vin) {
                this.getIdStatus(vin).catch((err) => {
                    this.log.error("get id status Failed");
                    this.refreshIDToken().catch((err) => { });
                });
                this.getIdParkingPosition(vin).catch((err) => {
                    this.log.error("get id parking position Failed");
                });
            }
            //this.getWcData();
        });
        return;
    }

    receiveLoginUrl() {
        return new Promise((resolve, reject) => {
            request(
                {
                    method: "GET",
                    url: "https://emea.bff.cariad.digital/user-login/v1/authorize?nonce=" + this.randomString(16) + "&redirect_uri=weconnect://authenticated",
                    headers: {
                        Host: "emea.bff.cariad.digital",
                        "user-agent": this.userAgent,
                        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "accept-language": "de-de",
                    },
                    jar: this.jar,
                    gzip: true,
                    followAllRedirects: false,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        this.log.error("Failed in receive login url ");
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        reject(err);
                        return;
                    }
                    resolve(resp.request.href);
                }
            );
        });
    }

    replaceVarInUrl(url, vin, tripType) {
        const curHomeRegion = this.homeRegion[vin];
        return url
            .replace("/$vin", "/" + vin + "")
            .replace("$homeregion/", curHomeRegion + "/")
            .replace("/$type/", "/" + this.type + "/")
            .replace("/$country/", "/" + this.country + "/")
            .replace("/$tripType", "/" + tripType);
    }

    getTokens(getRequest, code_verifier, reject, resolve) {
        let hash = "";
        if (getRequest.uri.hash) {
            hash = getRequest.uri.hash;
        } else {
            hash = getRequest.uri.query;
        }
        const hashArray = hash.split("&");
        // eslint-disable-next-line no-unused-vars
        let state;
        let jwtauth_code;
        let jwtaccess_token;
        let jwtid_token;
        let jwtstate;
        hashArray.forEach((hash) => {
            const harray = hash.split("=");
            if (harray[0] === "#state" || harray[0] === "state") {
                state = harray[1];
            }
            if (harray[0] === "code") {
                jwtauth_code = harray[1];
            }
            if (harray[0] === "access_token") {
                jwtaccess_token = harray[1];
            }
            if (harray[0] === "id_token") {
                jwtid_token = harray[1];
            }
            if (harray[0] === "#state") {
                jwtstate = harray[1];
            }
        });
        // const state = hashArray[0].substring(hashArray[0].indexOf("=") + 1);
        // const jwtauth_code = hashArray[1].substring(hashArray[1].indexOf("=") + 1);
        // const jwtaccess_token = hashArray[2].substring(hashArray[2].indexOf("=") + 1);
        // const jwtid_token = hashArray[5].substring(hashArray[5].indexOf("=") + 1);
        let method = "POST";
        let body = "auth_code=" + jwtauth_code + "&id_token=" + jwtid_token;
        let url = "https://emea.bff.cariad.digital/exchangeAuthCode";
        let headers = {
            // "user-agent": this.userAgent,
            "X-App-version": this.xappversion,
            "content-type": "application/x-www-form-urlencoded",
            "x-app-name": this.xappname,
            accept: "application/json",
        };

        body += "&brand=" + this.config.type;


        url = "https://emea.bff.cariad.digital/user-login/login/v1";
        let redirerctUri = "weconnect://authenticated";

        body = JSON.stringify({
            state: jwtstate,
            id_token: jwtid_token,
            redirect_uri: redirerctUri,
            region: "emea",
            access_token: jwtaccess_token,
            authorizationCode: jwtauth_code,
        });
        // @ts-ignore
        headers = {
            accept: "*/*",
            "content-type": "application/json",
            "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
            "user-agent": this.userAgent,
            "accept-language": "de-de",
        };
        if (this.type === "Wc") {
            reject();
            return;
            method = "GET";
            url = "https://emea.bff.cariad.digital/user-identity/v1/identity/login?redirect_uri=wecharge://authenticated&code=" + jwtauth_code;
            redirerctUri = "wecharge://authenticated";
            headers["x-api-key"] = "yabajourasW9N8sm+9F/oP==";
        }

        request(
            {
                method: method,
                url: url,
                headers: headers,
                body: body,
                jar: this.jar,
                gzip: true,
                followAllRedirects: false,
            },
            (err, resp, body) => {
                if (err || (resp && resp.statusCode >= 400)) {
                    this.log.error("Failed to get token");
                    err && this.log.error(err);
                    resp && this.log.error(resp.statusCode.toString());
                    body && this.log.error(JSON.stringify(body));
                    reject(err);
                    return;
                }
                try {
                    const tokens = JSON.parse(body);

                    this.getVWToken(tokens, jwtid_token, reject, resolve);
                } catch (err) {
                    this.log.error(err);
                    reject(err);
                }
            }
        );
    }

    getVWToken(tokens, jwtid_token, reject, resolve) {

        if (this.type === "Wc") {
            this.config.wc_access_token = tokens.wc_access_token;
            this.config.wc_refresh_token = tokens.refresh_token;
            this.log.debug("Wallcharging login successfull");
            this.getWcData(this.config.historyLimit);
            resolve();
            return;
        }
        this.config.atoken = tokens.accessToken;
        this.config.rtoken = tokens.refreshToken;

        //configure for wallcharging login

        this.refreshTokenInterval = setInterval(() => {
            this.refreshIDToken().catch((err) => { });
        }, 0.9 * 60 * 60 * 1000); // 0.9hours

        //this.config.type === "wc"
        this.type = "Wc";
        this.country = "DE";
        this.clientId = "0fa5ae01-ebc0-4901-a2aa-4dd60572ea0e@apps_vw-dilab_com";
        this.xclientId = "";
        this.scope = "openid profile address email";
        this.redirect = "wecharge://authenticated";
        this.xrequest = "com.volkswagen.weconnect";
        this.responseType = "code id_token token";
        this.xappversion = "";
        this.xappname = "";
        this.login().catch((err) => {
            this.log.debug("Failled wall charger login");
        });
        resolve();
        return;


        this.config.atoken = tokens.access_token;
        this.config.rtoken = tokens.refresh_token;

        if (this.refreshTokenInterval) {
            clearInterval(this.refreshTokenInterval);
        }
        this.refreshTokenInterval = setInterval(() => {
            this.refreshToken().catch((err) => {
                this.log.error("Refresh Token was not successful");
            });
        }, 0.9 * 60 * 60 * 1000); // 0.9hours

        resolve();
        return;

        request.post(
            {
                url: "https://mbboauth-1d.prd.ece.vwg-connect.com/mbbcoauth/mobile/oauth2/v1/token",
                headers: {
                    "User-Agent": this.userAgent,
                    "X-App-Version": this.xappversion,
                    "X-App-Name": this.xappname,
                    "X-Client-Id": this.xclientId,
                    Host: "mbboauth-1d.prd.ece.vwg-connect.com",
                },
                form: {
                    grant_type: "id_token",
                    token: jwtid_token,
                    scope: "sc2:fal",
                },
                jar: this.jar,
                gzip: true,
                followAllRedirects: true,
            },
            (err, resp, body) => {
                if (err || (resp && resp.statusCode >= 400)) {
                    this.log.error("Failed to get VWToken");
                    err && this.log.error(err);
                    resp && this.log.error(resp.statusCode.toString());
                    body && this.log.error(JSON.stringify(body));
                    resolve();
                    return;
                }
                try {
                    const tokens = JSON.parse(body);
                    this.config.vwatoken = tokens.access_token;
                    this.config.vwrtoken = tokens.refresh_token;
                    if (this.vwrefreshTokenInterval) {
                        clearInterval(this.vwrefreshTokenInterval);
                    }
                    this.vwrefreshTokenInterval = setInterval(() => {
                        this.refreshToken(true).catch((err) => {
                            this.log.error("Refresh Token was not successful");
                        });
                    }, 0.9 * 60 * 60 * 1000); //0.9hours
                    resolve();
                } catch (err) {
                    this.log.error(err);
                    reject(err);
                }
            }
        );
    }

    refreshToken(isVw) {
        let url = "https://emea.bff.cariad.digital/refreshTokens";
        let rtoken = this.config.rtoken;
        let body = "refresh_token=" + rtoken;
        let form = "";

        body = "brand=" + this.config.type + "&" + body;
        let headers = {
            "user-agent": this.userAgent,
            "content-type": "application/x-www-form-urlencoded",
            "X-App-version": this.xappversion,
            "X-App-name": this.xappname,
            "X-Client-Id": this.xclientId,
            accept: "application/json",
        };

        if (isVw) {
            url = "https://mbboauth-1d.prd.ece.vwg-connect.com/mbbcoauth/mobile/oauth2/v1/token";
            rtoken = this.config.vwrtoken;
            body = "grant_type=refresh_token&scope=sc2%3Afal&token=" + rtoken; //+ "&vin=" + vin;
        }
        return new Promise((resolve, reject) => {
            this.log.debug("refreshToken ");
            this.log.debug(isVw ? "vw" : "");
            request.post(
                {
                    url: url,
                    headers: headers,
                    body: body,
                    form: form,
                    gzip: true,
                    followAllRedirects: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        this.log.error("Failing to refresh token. ");
                        this.log.error(isVw ? "VwToken" : "");
                        err && this.log.error(err);
                        body && this.log.error(body);
                        resp && this.log.error(resp.statusCode.toString());
                        setTimeout(() => {
                            this.log.error("Restart adapter in 10min");
                            this.restart();
                        }, 10 * 60 * 1000);

                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug(JSON.stringify(body));
                        const tokens = JSON.parse(body);
                        if (tokens.error) {
                            this.log.error(JSON.stringify(body));
                            clearTimeout(this.refreshTokenTimeout());
                            this.refreshTokenTimeout = setTimeout(() => {
                                this.refreshTokenTimeout = null;
                                this.refreshToken(isVw).catch((err) => {
                                    this.log.error("refresh token failed");
                                });
                            }, 5 * 60 * 1000);
                            reject(err);
                            return;
                        }
                        if (isVw) {
                            this.config.vwatoken = tokens.access_token;
                            if (tokens.refresh_token) {
                                this.config.vwrtoken = tokens.refresh_token;
                            }
                        } else {
                            this.config.atoken = tokens.access_token;
                            if (tokens.refresh_token) {
                                this.config.rtoken = tokens.refresh_token;
                            }
                            if (tokens.accessToken) {
                                this.config.atoken = tokens.accessToken;
                                this.config.rtoken = tokens.refreshToken;
                            }
                            if (tokens.token) {
                                this.config.atoken = tokens.token;
                            }
                        }
                        resolve();
                    } catch (err) {
                        this.log.error("Failing to parse refresh token. The instance will do restart and try a relogin.");
                        this.log.error(err);
                        this.log.error(JSON.stringify(body));
                        this.log.error(resp.statusCode.toString());
                        this.log.error(err.stack);
                        this.restart();
                    }
                }
            );
        });
    }

    getPersonalData() {
        return new Promise((resolve, reject) => {
            this.log.debug("START getPersonalData()");

            resolve();
            return;
        });
    }


    getVehicles() {
        return new Promise((resolve, reject) => {
            this.log.debug("START getVehicles");
            let url = this.replaceVarInUrl("https://msg.volkswagen.de/fs-car/usermanagement/users/v1/$type/$country/vehicles");
            let headers = {
                "User-Agent": this.userAgent,
                "X-App-Version": this.xappversion,
                "X-App-Name": this.xappname,
                Authorization: "Bearer " + this.config.vwatoken,
                Accept: "application/json",
            };

            url = "https://emea.bff.cariad.digital/vehicle/v1/vehicles";
            headers = {
                accept: "*/*",
                "content-type": "application/json",
                "content-version": "1",
                "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                "user-agent": this.userAgent,
                "accept-language": "de-de",
                authorization: "Bearer " + this.config.atoken,
            };

            request.get(
                {
                    url: url,
                    headers: headers,
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode);
                        reject(err);
                    }
                    try {
                        if (body.errorCode) {
                            this.log.error(JSON.stringify(body));
                            reject(err);
                            return;
                        }
                        this.log.debug("getVehicles: " + JSON.stringify(body));
                        this.vehicles = body;
                        this.boolFinishVehicles = true;


                        if (Array.isArray(body.data) && body.data.length > 0) {
                            body.data.forEach((element) => {
                                const vin = element.vin;
                                if (!vin) {
                                    this.log.info("No vin found for:" + JSON.stringify(element));
                                    return;
                                }
                                this.vinArray.push(vin);
                            });
                        } else {
                            this.log.error("No data in server response");
                        }
                        resolve();
                        return;

                    } catch (err) {
                        this.log.error(err);
                        this.log.error(err.stack);
                        this.log.error("Not able to find vehicle, did you choose the correct type?");
                        reject(err);
                    }
                }
            );
        });
        this.log.debug("END getVehicles");
    }

    getWcData(limit) {
        if (!limit) {
            limit = 25;
        }
        const header = {
            accept: "*/*",
            "content-type": "application/json",
            "content-version": "1",
            "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
            "user-agent": this.userAgent,
            "accept-language": "de-de",
            authorization: "Bearer " + this.config.atoken,
            wc_access_token: this.config.wc_access_token,
        };
        this.genericRequest("https://emea.bff.cariad.digital/charge-and-pay/v1/user/subscriptions", header, "wecharge.chargeandpay.subscriptions", [404], "result")
            .then((body) => {
                body.forEach((subs) => {
                    this.genericRequest("https://emea.bff.cariad.digital/charge-and-pay/v1/user/tariffs/" + subs.tariff_id, header, "wecharge.chargeandpay.tariffs." + subs.tariff_id, [
                        404,
                    ]).catch((hideError) => {
                        if (hideError) {
                            this.log.debug("Failed to get tariff");
                            return;
                        }
                        this.log.error("Failed to get tariff");
                    });
                });
            })
            .catch((hideError) => {
                if (hideError) {
                    this.log.debug("Failed to get subscription");
                    return;
                }
                this.log.error("Failed to get subscription");
            });
        this.genericRequest("https://emea.bff.cariad.digital/charge-and-pay/v1/charging/records?limit=" + limit + "&offset=0", header, "wecharge.chargeandpay.records", [404], "result")
            .then((body) => {
                this.log.debug("wecharge.chargeandpay.records.newestItem: " + JSON.stringify(body));
                this.chargeAndPay = body;
                this.boolFinishChargeAndPay = true;
            })
            .catch((hideError) => {
                this.boolFinishChargeAndPay = true;
                if (hideError) {
                    this.log.debug("Failed to get chargeandpay records");
                    return;
                }
                this.log.error("Failed to get chargeandpay records");

            });
        this.genericRequest("https://emea.bff.cariad.digital/home-charging/v1/stations?limit=" + limit, header, "wecharge.homecharging.stations", [404], "result", "stations")
            .then((body) => {
                this.stations = body;
                this.boolFinishStations = true;
                body.forEach((station) => {
                    this.log.debug("Station: " + station.name + "/" + station.id);
                    this.genericRequest(
                        "https://emea.bff.cariad.digital/home-charging/v1/charging/sessions?station_id=" + station.id + "&limit=" + limit,
                        header,
                        "wecharge.homecharging.stations." + station.name + ".sessions",
                        [404],
                        "charging_sessions"
                    )
                        .then((body) => {
                            this.log.debug("wecharge.homecharging.stations." + station.name + ".sessions.newesItem: " + JSON.stringify(body[0]));
                        })
                        .catch((hideError) => {
                            if (hideError) {
                                this.log.debug("Failed to get sessions");
                                return;
                            }
                            this.log.error("Failed to get sessions");
                        });
                });
            })
            .catch((hideError) => {
                this.boolFinishStations = true;
                if (hideError) {
                    this.log.debug("Failed to get stations");
                    return;
                }
                this.log.error("Failed to get stations");
            });
        const dt = new Date();
        this.genericRequest(
            "https://emea.bff.cariad.digital/home-charging/v1/charging/records?start_date_time_after=2020-05-01T00:00:00.000Z&start_date_time_before=" + dt.toISOString() + "&limit=" + limit,
            header,
            "wecharge.homecharging.records",
            [404],
            "charging_records"
        )
            .then((body) => {
                this.log.debug("wecharge.homecharging.records.newesItem: " + JSON.stringify(body));
                this.homechargingRecords = body;
                this.boolFinishHomecharging = true;
            })
            .catch((hideError) => {
                this.boolFinishHomecharging = true;
                if (hideError) {
                    this.log.debug("Failed to get records");
                    return;
                }
                this.log.error("Failed to get records");
            });
        //Pay
        //Home
    }

    genericRequest(url, header, path, codesToIgnoreArray, selector1, selector2) {
        return new Promise(async (resolve, reject) => {
            header["If-None-Match"] = this.etags[url] || "";
            request.get(
                {
                    url: url,
                    headers: header,
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (resp && resp.statusCode && codesToIgnoreArray.includes(resp.statusCode)) {
                            err && this.log.debug(err);
                            resp && this.log.debug(resp.statusCode.toString());
                            body && this.log.debug(JSON.stringify(body));
                            reject(true, err);
                            return;
                        }

                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        reject(false, err);
                        return;
                    }

                    this.log.debug("genericRequest <" + url + ">: " + JSON.stringify(body));
                    this.etags[url] = resp.headers.etag;

                    if (resp.statusCode === 304) {
                        this.log.debug("304 No values updated");
                        resolve();
                        return;
                    }
                    try {
                        if (selector1) {
                            body = body[selector1];
                            if (selector2) {
                                body = body[selector2];
                            }
                        }
                        resolve(body);
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    async checkSafeFlag(timeout) {
        return new Promise((resolve, reject) => {
            var counter = 0
            let checkInterval = setInterval(() => {
                if (this.idData.access.accessStatus.value.overallStatus == "safe") {
                    clearInterval(checkInterval);
                    this.config.unSafe = false;
                    module.exports.idStatusEmitter.emit('statusNotSafe', false);
                    reject('safe');
                    return;
                }
                if (counter++ >= timeout / 2) {
                    clearInterval(checkInterval);
                    this.config.unSafe = true;
                    module.exports.idStatusEmitter.emit('statusNotSafe', true);
                    resolve();
                    return;
                }
            }, 30 * 1000);
        }).catch((err) => {
            this.log.debug(err);
        });
    }

    async checkPlugAndPower(timeout) {
        return new Promise((resolve, reject) => {
            var counter = 0
            let checkInterval = setInterval(() => {
                if (this.idData.charging.plugStatus.value.externalPower == "ready" || this.idData.charging.plugStatus.value.externalPower == "active") {
                    clearInterval(checkInterval);
                    this.config.noExternalPower = false;
                    module.exports.idStatusEmitter.emit('noExternalPower', false);
                    reject('powerReady');
                    return;
                }
                if (counter++ >= timeout / 2) {
                    clearInterval(checkInterval);
                    this.config.noExternalPower = true;
                    module.exports.idStatusEmitter.emit('noExternalPower', true);
                    resolve();
                    return;
                }
            }, 30 * 1000);
        }).catch((err) => {
            this.log.debug(err);
        });
    }

    async logToDb(odo, soc, rng, lat = null, lon = null) {
      const sql = `INSERT INTO travel (vin, odo, soc, \`range\`, lat, lon)
                   VALUES (?, ?, ?, ?, ?, ?)`;
      const toNum = v => (Number.isFinite(Numer(v)) ? Number(v) : null);
      const [result] = await this.config.db.promise().execute(sql, [
        this.currSession?.vin ?? null,
        toNum(odo),
        toNum(soc),
        toNum(rng),
        toNum(lat),
        toNum(lon)
      ]);
      return result.insertId;
    }
    
    runEventEmitters() {
        module.exports.idStatusEmitter.emit('eventRunStarted');
        if (typeof (this.idDataOld) == "undefined") {
            return;
        }

        try {
            // parking
            if (this.idData.parking.data.carIsParked != this.idDataOld.parking.data.carIsParked) {
                if (this.idData.parking.data.carIsParked) {
                     if (this.config.db) {
                         (async () => {
                          try {
                            const odo = Number(this.idData?.measurements?.odometerStatus?.value?.odometer ?? null);
                            const soc = Number(this.idData?.charging?.batteryStatus?.value?.currentSOC_pct ?? null);
                            const rng = Number(this.idData?.charging?.batteryStatus?.value?.cruisingRangeElectric_km ?? null);
                            const lat = this.idParkingPosition?.data?.lat ?? null;
                            const lon = this.idParkingPosition?.data?.lon ?? null;
                
                            const id = await this.logToDb(odo, soc, rng, lat, lon);
                          } catch (err) {
                            console.error('DB error:', err);
                          }
                        })();
                     }
                    
                    module.exports.idStatusEmitter.emit('positionUpdate', this.idData.parking.data);
                    
                } else {
                    if (this.config.db) {
                    (async () => {
                          try {
                            const odo = Number(this.idData?.status?.vehicleStatus?.value?.odometer ?? null);
                            const soc = Number(this.idData?.charging?.batteryStatus?.value?.currentSOC_pct ?? null);
                            const rng = Number(this.idData?.charging?.batteryStatus?.value?.cruisingRangeElectric_km ?? null);
                
                            const id = await this.logToDb(odo, soc, rng);
                          } catch (err) {
                            console.error('DB error:', err);
                          }
                        })();
                    }
                    
                    module.exports.idStatusEmitter.emit('positionUnknown');
                }
                module.exports.idStatusEmitter.emit('parked', this.idData.parking.data.carIsParked);
                module.exports.idStatusEmitter.emit('notParked', !this.idData.parking.data.carIsParked);
            }
            if (this.idData.parking.data.carIsParked && (this.idData.access.accessStatus.value.overallStatus != "safe") && (!this.idDataOld.parking.data.carIsParked || (this.idDataOld.access.accessStatus.value.overallStatus == "safe"))) {
                this.checkSafeFlag(this.config.checkSafeStatusTimeout);
            }

            if ( (this.idData.access.accessStatus.value.overallStatus == "safe") && (this.idDataOld.access.accessStatus.value.overallStatus != "safe") ) {
                module.exports.idStatusEmitter.emit('statusNotSafe', false);
                this.config.unSafe = false;
            }

            if ( (this.idData.access.accessStatus.value.doorLockStatus != "locked") && (this.idDataOld.access.accessStatus.value.doorLockStatus == "locked") ) { module.exports.idStatusEmitter.emit('carLocked', false); }
            if ( (this.idData.access.accessStatus.value.doorLockStatus == "locked") && (this.idDataOld.access.accessStatus.value.doorLockStatus != "locked") ) { module.exports.idStatusEmitter.emit('carLocked', true); }


            // charging
            if ((this.idData.charging.chargingStatus.value.chargingState.includes("chargePurposeReached") || (this.idData.charging.chargingStatus.value.chargingState != "charging" && this.idData.charging.chargingSettings.value.targetSOC_pct == this.idData.charging.batteryStatus.value.currentSOC_pct)) && this.idDataOld.charging.chargingStatus.value.chargingState == "charging") { module.exports.idStatusEmitter.emit('chargePurposeReached'); }
            if (this.idData.charging.chargingStatus.value.chargingState == "charging" && this.idDataOld.charging.chargingStatus.value.chargingState != "charging") { module.exports.idStatusEmitter.emit('chargingStarted'); }
            if (this.idData.charging.chargingStatus.value.chargingState != "charging" && this.idDataOld.charging.chargingStatus.value.chargingState == "charging") { module.exports.idStatusEmitter.emit('chargingStopped'); }
            if (this.idData.charging.batteryStatus.value.currentSOC_pct != this.idDataOld.charging.batteryStatus.value.currentSOC_pct) { module.exports.idStatusEmitter.emit('currentSOC', this.idData.charging.batteryStatus.value.currentSOC_pct); }
            if (this.idData.charging.batteryStatus.value.cruisingRangeElectric_km != this.idDataOld.charging.batteryStatus.value.cruisingRangeElectric_km) { module.exports.idStatusEmitter.emit('remainingRange', this.idData.charging.batteryStatus.value.cruisingRangeElectric_km); }
            if (this.idData.charging.plugStatus.value.plugConnectionState == "connected" && this.idDataOld.charging.plugStatus.value.plugConnectionState == "disconnected") {
                this.checkPlugAndPower(this.config.checkSafeStatusTimeout);
            }

            if ( (this.idData.charging.plugStatus.value.plugConnectionState == "disconnected" && this.idDataOld.charging.plugStatus.value.plugConnectionState == "connected") ||
                 ((this.idData.charging.plugStatus.value.externalPower == "ready" || this.idData.charging.plugStatus.value.externalPower == "active") && this.config.noExternalPower) ) {
                module.exports.idStatusEmitter.emit('noExternalPower', false);
                this.config.noExternalPower = false;
            }

            if (this.idData.charging.chargingSettings.value.targetSOC_pct != this.idDataOld.charging.chargingSettings.value.targetSOC_pct) { module.exports.idStatusEmitter.emit('targetSOCupdated'); }
            if (this.idData.charging.chargingSettings.value.maxChargeCurrentAC != this.idDataOld.charging.chargingSettings.value.maxChargeCurrentAC) { module.exports.idStatusEmitter.emit('reducedACupdated'); }
            if (this.idData.charging.chargingSettings.value.autoUnlockPlugWhenCharged != this.idDataOld.charging.chargingSettings.value.autoUnlockPlugWhenCharged) { module.exports.idStatusEmitter.emit('autoUnlockPlugUpdated'); }

            // climatisation
            if (this.idData.climatisation.climatisationStatus.value.climatisationState == "off" && this.idDataOld.climatisation.climatisationStatus.value.climatisationState != "off") { module.exports.idStatusEmitter.emit('climatisationStopped'); }
            if (this.idData.climatisation.climatisationStatus.value.climatisationState != "off" && this.idDataOld.climatisation.climatisationStatus.value.climatisationState == "off") { module.exports.idStatusEmitter.emit('climatisationStarted'); }
            if (this.idData.climatisation.climatisationStatus.value.climatisationState == "cooling" && this.idDataOld.climatisation.climatisationStatus.value.climatisationState != "cooling") { module.exports.idStatusEmitter.emit('climatisationCoolingStarted'); }
            if (this.idData.climatisation.climatisationStatus.value.climatisationState == "heating" && this.idDataOld.climatisation.climatisationStatus.value.climatisationState != "heating") { module.exports.idStatusEmitter.emit('climatisationHeatingStarted'); }
            if (this.idData.climatisation.climatisationSettings.value.targetTemperature_C != this.idDataOld.climatisation.climatisationSettings.value.targetTemperature_C) { module.exports.idStatusEmitter.emit('climatisationTemperatureUpdated'); }
            if (this.idData.climatisation.climatisationSettings.value.climatizationAtUnlock != this.idDataOld.climatisation.climatisationSettings.value.climatizationAtUnlock) { module.exports.idStatusEmitter.emit('climatisationAtUnlockUpdated'); }
            if (this.idData.climatisation.climatisationSettings.value.windowHeatingEnabled != this.idDataOld.climatisation.climatisationSettings.value.windowHeatingEnabled) { module.exports.idStatusEmitter.emit('windowHeatingUpdated'); }
            if (this.idData.climatisation.climatisationSettings.value.zoneFrontLeftEnabled != this.idDataOld.climatisation.climatisationSettings.value.zoneFrontLeftEnabled) { module.exports.idStatusEmitter.emit('zoneFrontLeftUpdated'); }
            if (this.idData.climatisation.climatisationSettings.value.zoneFrontRightEnabled != this.idDataOld.climatisation.climatisationSettings.value.zoneFrontRightEnabled) { module.exports.idStatusEmitter.emit('zoneFrontRightUpdated'); }

            if (this.config.backendError) {
                this.log.info("Current car state back in sync with VW backend.");
                module.exports.idStatusEmitter.emit('backendError', false);
                this.config.backendError = false;
            }

        } catch (err) {
            if (!this.config.backendError) {
                this.log.error("Current car state not (correctly) received from VW backend.");
                this.log.debug(err);
                module.exports.idStatusEmitter.emit('backendError', true);
                this.config.backendError = true;
            }
        }
    }

    populateConfig() {
        this.log.debug("START populateConfig");

        this.config.targetTempC = this.idData.climatisation.climatisationSettings.value.targetTemperature_C;
        this.config.targetSOC = this.idData.charging.chargingSettings.value.targetSOC_pct;
        this.config.chargeCurrent = this.idData.charging.chargingSettings.value.maxChargeCurrentAC;
        this.config.autoUnlockPlug = this.idData.charging.chargingSettings.value.autoUnlockPlugWhenCharged === 'permanent';
        this.config.climatizationAtUnlock = this.idData.climatisation.climatisationSettings.value.climatizationAtUnlock;
        this.config.climatisationWindowHeating = this.idData.climatisation.climatisationSettings.value.windowHeatingEnabled;
        this.config.climatisationFrontLeft = this.idData.climatisation.climatisationSettings.value.zoneFrontLeftEnabled;
        this.config.climatisationFrontRight = this.idData.climatisation.climatisationSettings.value.zoneFrontRightEnabled;

        this.log.debug("END populateConfig");

    }

    getIdStatus(vin) {
        return new Promise((resolve, reject) => {
            this.log.debug("START getIdStatus");
            request.get(
                {
                    url: "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" + vin + "/selectivestatus?jobs=access,activeVentilation,auxiliaryHeating,batteryChargingCare,batterySupport,charging,chargingProfiles,climatisation,climatisationTimers,departureProfiles,fuelStatus,honkAndFlash,hybridCarAuxiliaryHeating,userCapabilities,vehicleHealthWarnings,vehicleHealthInspection,vehicleLights,measurements,departureTimers",

                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        "content-version": "1",
                        "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                        "user-agent": this.userAgent,
                        "accept-language": "de-de",
                        authorization: "Bearer " + this.config.atoken,
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode);

                        reject(err);
                        return;
                    }
                    //this.log.debug("getIdStatus: " + JSON.stringify(body));

                    if (typeof (this.idData) != "undefined") {
                        this.idDataOld = this.idData;
                    }

                    this.idData = body;

                    if (typeof (this.idData) != "undefined") {
                        if (this.pendingRequests == 0) {
                            this.populateConfig();
                        }
                    }

                    if (typeof (this.idParkingPosition) != "undefined") {
                        this.idData.parking = {};
                        Object.assign(this.idData.parking, this.idParkingPosition);
                    }

                    this.runEventEmitters();

                    this.boolFinishIdData = true;

                    try {
                        const adapter = this;
                        traverse(body.data).forEach(function (value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        modPath[parentIndex] = key;
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                if (modPath[modPath.length - 1] !== "$") {
                                    if (typeof value === "object") {
                                        value = JSON.stringify(value);
                                    }
                                }
                            }
                        });

                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
            this.log.debug("END getIdStatus");
        });
    }

    getIdParkingPosition(vin) {
        if (!this.hasParkingPosition(vin)) {
            this.log.debug(`VIN ${vin} has no parkingPosition capability`);
            return Promise.resolve(null); // altijd een Promise
        }
  
        //if (this.currSession && vin !== this.currSession.vin) {
        //   return Promise.resolve(null);
        //}
        return new Promise((resolve, reject) => {
            this.log.debug("START getIdParkingPosition");
            request.get(
                {
                    url: "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" + vin + "/parkingposition",

                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        "content-version": "1",
                        "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                        "user-agent": this.userAgent,
                        "accept-language": "de-de",
                        authorization: "Bearer " + this.config.atoken,
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode);

                        reject(err);
                        return;
                    }
                    this.log.debug("getIdParkingPosition: " + JSON.stringify(body));
                    if (typeof (body) != "undefined") {
                        this.idParkingPosition = body;
                        this.idParkingPosition.data.carIsParked = true;
                    } else {
                        this.idParkingPosition = { "data": { "carIsParked": false } };
                    }

                    try {
                        const adapter = this;
                        traverse(this.idParkingPosition).forEach(function (value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        modPath[parentIndex] = key;
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                if (modPath[modPath.length - 1] !== "$") {
                                    if (typeof value === "object") {
                                        value = JSON.stringify(value);
                                    }
                                }
                            }
                        });

                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
            this.log.debug("END getIdParkingPosition");
        });
    }

    setIdRemote(vin, action, value, bodyContent) {
        return new Promise(async (resolve, reject) => {
            this.log.debug("setIdRemote >>");
            let body = bodyContent || {};
            if (action === "climatisation" && value === "settings") {
                const climateStates = this.idData.climatisation.climatisationSettings.value; // get this from the internal object filled by getData()
                body = {};
                const allIds = Object.keys(climateStates);
                allIds.forEach((keyName) => {
                    let key = keyName.split(".").splice(-1)[0];

                    if (key == "targetTemperature_C") {
                        key = "targetTemperature";
                        if (this.config.targetTempC >= 16 && this.config.targetTempC <= 27) {
                            climateStates[keyName] = this.config.targetTempC;
                        } else if (this.config.targetTempC != -1) {
                            this.log.error("Cannot set temperature to " + this.config.targetTempC + "°C.");
                            reject(err);
                            return;
                        }
                    }

                    if (key == "targetTemperature_K" || key == "targetTemperature_F") {
                        return;
                        //climateStates[keyName] = this.config.targetTempC + 273.15;
                    }

                    if (key == "unitInCar") {
                        key = "targetTemperatureUnit";
                    }

                    if (key == "climatizationAtUnlock") {
                        climateStates[keyName] = this.config.climatizationAtUnlock;
                    }
                    if (key == "windowHeatingEnabled") {
                        climateStates[keyName] = this.config.climatisationWindowHeating;
                    }
                    if (key == "zoneFrontLeftEnabled") {
                        climateStates[keyName] = this.config.climatisationFrontLeft;
                    }
                    if (key == "zoneFrontRightEnabled") {
                        climateStates[keyName] = this.config.climatisationFrontRight;
                    }

                    if (key.indexOf("Timestamp") === -1) {
                        body[key] = climateStates[keyName];
                    }
                });
                body["climatisationWithoutExternalPower"] = true;

                // body = JSON.stringify(body);
                this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
            }
            if (action === "charging" && value === "settings") {
                const chargingStates = this.idData.charging.chargingSettings.value; // get this from the internal object filled by getData()
                body = {};
                const allIds = Object.keys(chargingStates);
                allIds.forEach((keyName) => {
                    const key = keyName.split(".").splice(-1)[0];
                    if (this.config.targetSOC >= 50 && this.config.targetSOC <= 100) {
                        if (key == "targetSOC_pct") {
                            chargingStates[keyName] = this.config.targetSOC;
                        }
                    }
                    if (this.config.chargeCurrent == "maximum" || this.config.chargeCurrent == "reduced") {
                        if (key == "maxChargeCurrentAC") {
                            chargingStates[keyName] = this.config.chargeCurrent;
                        }
                    }
                    if (key == "autoUnlockPlugWhenCharged") {
                        chargingStates[keyName] = this.config.autoUnlockPlug ? "permanent" : "off";
                    }
                    else {
                        //this.log.error("Cannot set target SOC to " + this.config.targetSOC + "%, and charge current to "+ this.config.chargeCurrent + ".");
                        //reject(err);
                        //return;
                    }
                    if (key.indexOf("Timestamp") === -1) {
                        body[key] = chargingStates[keyName];
                    }
                });
                this.config.pendingRequests = Math.max(this.config.pendingRequests - 1, 0);
            }
            let method = "POST";
            if (value === "settings" || action === "destinations") {
                method = "PUT";
            }

            let urlString = "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" + vin + "/" + action + "/" + value;
            if (action === "destinations") {
                urlString = "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" + vin + "/" + action;
            }
            this.log.debug(urlString);

            this.log.debug("setIdRemote: " + JSON.stringify(body));
            request(
                {
                    method: method,
                    url: urlString,

                    headers: {
                        "content-type": "application/json",
                        accept: "*/*",
                        "accept-language": "de-de",
                        "user-agent": this.userAgent,
                        "content-version": "1",
                        "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                        authorization: "Bearer " + this.config.atoken,
                    },
                    body: body,
                    followAllRedirects: true,
                    json: true,
                    gzip: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (resp && resp.statusCode === 401) {
                            err && this.log.error(err);
                            resp && this.log.error(resp.statusCode.toString());
                            body && this.log.error(JSON.stringify(body));
                            this.refreshIDToken().catch((err) => { });
                            this.log.error("Refresh Token");
                            reject(err);
                            return;
                        }
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug(JSON.stringify(body));
                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    refreshIDToken() {
        return new Promise((resolve, reject) => {
            this.log.debug("Token Refresh started");
            request.get(
                {
                    url: "https://emea.bff.cariad.digital/user-login/refresh/v1",

                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        "content-version": "1",
                        "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                        "user-agent": this.userAgent,
                        "accept-language": "de-de",
                        authorization: "Bearer " + this.config.rtoken,
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        this.log.error("Failed refresh token. Relogin");
                        //reset login parameters because of wecharge
                        this.type = "Id";
                        this.clientId = "a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com";
                        this.scope = "openid profile badge cars dealers birthdate vin";
                        this.redirect = "weconnect://authenticated";
                        this.xrequest = "com.volkswagen.weconnect";
                        this.responseType = "code id_token token";
                        setTimeout(() => {
                            this.log.error("Restart adapter in 10min");
                            this.restart();
                        }, 10 * 60 * 1000);
                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug("Token Refresh successful");
                        this.config.atoken = body.accessToken;
                        this.config.rtoken = body.refreshToken;
                        if (this.type === "Wc") {
                            //wallcharging relogin no refresh token available
                            this.login().catch((err) => {
                                this.log.debug("No able to Login in WeCharge");
                            });
                        }
                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    getVehicleData(vin) {
        return new Promise((resolve, reject) => {

            let accept = "application/vnd.vwg.mbb.vehicleDataDetail_v2_1_0+json, application/vnd.vwg.mbb.genericError_v1_0_2+json";
            let url = this.replaceVarInUrl("$homeregion/fs-car/vehicleMgmt/vehicledata/v2/$type/$country/vehicles/$vin/", vin);

            const atoken = this.config.vwatoken;

            request.get(
                {
                    url: url,
                    headers: {
                        "User-Agent": this.userAgent,
                        "X-App-Version": this.xappversion,
                        "X-App-Name": this.xappname,
                        "X-Market": "de_DE",
                        Authorization: "Bearer " + atoken,
                        "If-None-Match": this.etags[url] || "",
                        Accept: accept,
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (resp && resp.statusCode === 429) {
                            this.log.error("Too many requests. Please turn on your car to send new requests. Maybe force update/update erzwingen is too often.");
                        }
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(JSON.stringify(body));
                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug(JSON.stringify(body));
                        let result = body.vehicleData;
                        if (!result) {
                            result = body.vehicleDataDetail;
                        }
                        if (resp) {
                            this.etags[url] = resp.headers.etag;
                            if (resp.statusCode === 304) {
                                this.log.debug("304 No values updated");
                                resolve();
                                return;
                            }
                        }
                        if (result && result.carportData && result.carportData.modelName) {
                            this.updateName(vin, result.carportData.modelName);
                        }

                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    getVehicleRights(vin) {
        return new Promise((resolve, reject) => {
            if (!this.config.rights) {
                resolve();
                return;
            }
            let url = "https://mal-1a.prd.ece.vwg-connect.com/api/rolesrights/operationlist/v3/vehicles/" + vin;

            request.get(
                {
                    url: url,
                    qs: {
                        scope: "All",
                    },
                    headers: {
                        "User-Agent": this.userAgent,
                        "X-App-Version": this.xappversion,
                        "X-App-Name": this.xappname,
                        Authorization: "Bearer " + this.config.vwatoken,
                        Accept: "application/json, application/vnd.vwg.mbb.operationList_v3_0_2+xml, application/vnd.vwg.mbb.genericError_v1_0_2+xml",
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (resp && resp.statusCode === 429) {
                            this.log.error("Too many requests. Please turn on your car to send new requests. Maybe force update/update erzwingen is too often.");
                        }
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        reject(err);
                        return;
                    }
                    try {
                        const adapter = this;
                        traverse(body.operationList).forEach(function (value) {
                            if (this.path.length > 0 && this.isLeaf) {
                                const modPath = this.path;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (!isNaN(parseInt(pathElement))) {
                                        let stringPathIndex = parseInt(pathElement) + 1 + "";
                                        while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                        const key = this.path[pathIndex - 1] + stringPathIndex;
                                        const parentIndex = modPath.indexOf(pathElement) - 1;
                                        modPath[parentIndex] = key;
                                        modPath.splice(parentIndex + 1, 1);
                                    }
                                });
                                if (modPath[modPath.length - 1] !== "$") {
                                    if (typeof value === "object") {
                                        value = JSON.stringify(value);
                                    }
                                }
                            }
                        });

                        resolve();
                    } catch (err) {
                        this.log.error(err);
                        reject(err);
                    }
                }
            );
        });
    }

    requestStatusUpdate(vin) {
        return new Promise((resolve, reject) => {
            try {

                let method = "POST";
                let url = this.replaceVarInUrl("$homeregion/fs-car/bs/vsr/v1/$type/$country/vehicles/$vin/requests", vin);

                let accept = "application/json";
                // if (this.config.type === "audi") {
                //     url = this.replaceVarInUrl("https://mal-3a.prd.eu.dp.vwg-connect.com/api/bs/vsr/v1/vehicles/$vin/requests", vin);
                // }

                this.log.debug("Request update " + url);
                request(
                    {
                        method: method,
                        url: url,
                        headers: {
                            "User-Agent": this.userAgent,
                            "X-App-Version": this.xappversion,
                            "X-App-Name": this.xappname,
                            Authorization: "Bearer " + this.config.vwatoken,
                            "Accept-charset": "UTF-8",
                            Accept: accept,
                        },
                        followAllRedirects: true,
                        gzip: true,
                        json: true,
                    },
                    (err, resp, body) => {
                        if (err || (resp && resp.statusCode >= 400)) {
                            this.log.error(vin);
                            if (resp && resp.statusCode === 429) {
                                this.log.error("Too many requests. Please turn on your car to send new requests. Maybe force update/update erzwingen is too often.");
                            }
                            err && this.log.error(err);
                            resp && this.log.error(resp.statusCode.toString());
                            body && this.log.error(JSON.stringify(body));
                            reject(err);
                            return;
                        }
                        try {
                            this.log.debug(JSON.stringify(body));
                            resolve();
                        } catch (err) {
                            this.log.error("Request update failed: " + url);
                            this.log.error(vin);
                            this.log.error(err);
                            reject(err);
                        }
                    }
                );
            } catch (err) {
                this.log.error(err);
                reject(err);
            }
        });
    }

    getVehicleStatus(vin, url, path, element, element2, element3, element4, tripType) {
        return new Promise((resolve, reject) => {
            url = this.replaceVarInUrl(url, vin, tripType);
            if (path === "tripdata") {
                if (this.tripsActive == false) {
                    resolve();
                    return;
                }
            }
            let accept = "application/json";

            request.get(
                {
                    url: url,
                    headers: {
                        "User-Agent": this.userAgent,
                        "X-App-Version": this.xappversion,
                        "X-App-Name": this.xappname,
                        "If-None-Match": this.etags[url] || "",
                        Authorization: "Bearer " + this.config.vwatoken,
                        "Accept-charset": "UTF-8",
                        Accept: accept,
                    },
                    followAllRedirects: true,
                    gzip: true,
                    json: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if ((resp && resp.statusCode === 403) || (resp && resp.statusCode === 502) || (resp && resp.statusCode === 406) || (resp && resp.statusCode === 500)) {
                            body && this.log.debug(JSON.stringify(body));
                            resolve();
                            return;
                        } else if (resp && resp.statusCode === 401) {
                            this.log.error(vin);
                            err && this.log.error(err);
                            resp && this.log.error(resp.statusCode.toString());
                            body && this.log.error(JSON.stringify(body));
                            this.log.error("Refresh Token in 10min");
                            if (!this.refreshTokenTimeout) {
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshTokenTimeout = null;
                                    this.refreshToken(true).catch((err) => {
                                        this.log.error("Refresh Token was not successful");
                                    });
                                }, 10 * 60 * 1000);
                            }
                            reject(err);
                            return;
                        } else {
                            if (resp && resp.statusCode === 429) {
                                this.log.error("Too many requests. Please turn on your car to send new requests. Maybe force update/update erzwingen is too often.");
                            }
                            err && this.log.error(err);
                            resp && this.log.error(resp.statusCode.toString());
                            body && this.log.error(JSON.stringify(body));
                            reject(err);
                            return;
                        }
                    }
                    try {
                        this.log.debug("getVehicleStatus: " + JSON.stringify(body));
                        if (resp) {
                            this.etags[url] = resp.headers.etag;
                            if (resp.statusCode === 304) {
                                this.log.debug("304 No values updated");
                                resolve();
                                return;
                            }
                        }
                        if (path === "position") {
                            if (resp.statusCode === 204) {
                                // moving true
                                resolve();
                                return;
                            } else {
                                // moving false
                            }
                            if (body && body.storedPositionResponse && body.storedPositionResponse.parkingTimeUTC) {
                                body.storedPositionResponse.position.parkingTimeUTC = body.storedPositionResponse.parkingTimeUTC;
                            }
                        }

                        if (body === undefined || body === "" || body.error) {
                            if (body && body.error && body.error.description.indexOf("Token expired") !== -1) {
                                this.log.error("Error response try to refresh token " + path);
                                this.log.error(JSON.stringify(body));
                                this.log.error("Refresh Token in 10min");
                                if (!this.refreshTokenTimeout) {
                                    this.refreshTokenTimeout = setTimeout(() => {
                                        this.refreshTokenTimeout = null;
                                        this.refreshToken(true).catch((err) => {
                                            this.log.error("Refresh Token was not successful");
                                        });
                                    }, 10 * 60 * 1000);
                                }
                            } else {
                                this.log.debug("Not able to get " + path);
                            }
                            this.log.debug(body);
                            reject(err);
                            return;
                        }

                        const adapter = this;

                        let result = body;
                        if (result === "") {
                            resolve();
                            return;
                        }
                        if (result) {
                            if (element && result[element]) {
                                result = result[element];
                            }
                            if (element2 && result[element2]) {
                                result = result[element2];
                            }
                            if (element3 && result[element3]) {
                                result = result[element3];
                            }
                            if (element4 && result[element4]) {
                                result = result[element4];
                            }
                            const isStatusData = path === "status";
                            const isTripData = path === "tripdata";

                            if (isTripData) {
                                if (this.tripsActive == false) {
                                    resolve();
                                    return;
                                }
                                // result.tripData = result.tripData.reverse();
                                result.tripData.sort((a, b) => {
                                    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                                });
                                if (this.config.numberOfTrips > 0) result.tripData = result.tripData.slice(0, this.config.numberOfTrips);

                                resolve();
                                return;
                            }

                            var statusKeys = null;
                            if (isStatusData) {
                                statusKeys = this.getStatusKeys(result);
                            }
                            var tripKeys = null;
                            if (isTripData) {
                                tripKeys = this.getTripKeys(result);
                            }
                            traverse(result).forEach(function (value) {
                                const modPath = this.path.slice();
                                var dataId = null;
                                var dataIndex = -1;
                                var fieldId = null;
                                var fieldUnit = null;
                                var isNumberNode = false;
                                var skipNode = false;
                                this.path.forEach((pathElement, pathIndex) => {
                                    if (isNaN(parseInt(pathElement))) {
                                        isNumberNode = false;
                                    } else {
                                        isNumberNode = true;
                                        var key;
                                        if (isStatusData && this.path[pathIndex - 1] === "data") {
                                            dataIndex = parseInt(pathElement);
                                            dataId = statusKeys[dataIndex].dataId;
                                            key = "_" + dataId;
                                        } else if (isStatusData && this.path[pathIndex - 1] === "field") {
                                            if (dataIndex >= 0) {
                                                fieldId = statusKeys[dataIndex].fieldIds[parseInt(pathElement)].id;
                                                key = "_" + fieldId;
                                                if (this.key == "value" && statusKeys[dataIndex].fieldIds[parseInt(pathElement)].unit) {
                                                    fieldUnit = statusKeys[dataIndex].fieldIds[parseInt(pathElement)].unit;
                                                }
                                            } else {
                                                adapter.log.error("no data entry found for field (path = " + this.path.join("."));
                                                key = parseInt(pathElement) + 1 + "";
                                            }
                                        } else if (isTripData && this.path[pathIndex - 1]) {
                                            var tripKey = tripKeys[parseInt(pathElement)];
                                            if (tripKey === null) {
                                                skipNode = true;
                                            } else {
                                                key = "_" + tripKeys[parseInt(pathElement)];
                                            }
                                        } else {
                                            key = parseInt(pathElement) + 1 + "";
                                            while (key.length < 2) key = "0" + key;
                                        }
                                        if (!skipNode) {
                                            const parentIndex = modPath.indexOf(pathElement) - 1;
                                            modPath[parentIndex] = this.path[pathIndex - 1] + key;
                                            modPath.splice(parentIndex + 1, 1);
                                        }
                                    }
                                });
                                if (!skipNode) {
                                    const newPath = vin + "." + path + "." + modPath.join(".");
                                    if (this.path.length > 0 && this.isLeaf) {
                                        value = value || this.node;
                                        if (!isNaN(Number(value)) && Number(value) === parseFloat(value)) {
                                            value = Number(value);
                                        }
                                        if (typeof value === "object") {
                                            value = JSON.stringify(value);
                                        }
                                        if (isStatusData && this.key == "value") {
                                            if (dataId == "0x030104FFFF" && fieldId == "0x0301040001") {
                                                // if (value == 2) { isCarLocked = true };
                                            }
                                            if (dataId == "0x030102FFFF" && fieldId == "0x0301020001") {
                                                // outsideTemperature = Math.round(value - 2731.5) / 10.0
                                            }
                                            adapter.updateUnit(newPath, fieldUnit);
                                        }
                                    } else if (isStatusData && isNumberNode) {
                                        var text = null;
                                        if (this.node.textId) {
                                            text = this.node.textId;
                                        }
                                        adapter.updateName(newPath, text);
                                    } else if (isTripData && isNumberNode) {
                                        var text = null;
                                        if (this.node.timestamp) {
                                            text = this.node.timestamp;
                                        }
                                        adapter.updateName(newPath, text);
                                    }
                                }
                            });
                            resolve();
                        } else {
                            this.log.error("Cannot find vehicle data " + path);
                            this.log.error(JSON.stringify(body));
                            reject(err);
                        }
                    } catch (err) {
                        this.log.error(err);
                        this.log.error(err.stack);
                        reject(err);
                    }
                }
            );
        });
    }

    getStatusKeys(statusJson) {
        const adapter = this;
        var result = null;
        if (statusJson && statusJson.data) {
            if (Array.isArray(statusJson.data)) {
                result = new Array(statusJson.data.length);
                statusJson.data.forEach(function (dataValue, dataIndex) {
                    if (dataValue && dataValue.id) {
                        if (dataValue.field && Array.isArray(dataValue.field)) {
                            var newList = new Array(dataValue.field.length);
                            dataValue.field.forEach(function (fieldValue, fieldIndex) {
                                if (fieldValue && fieldValue.id) {
                                    newList[fieldIndex] = { id: fieldValue.id, unit: fieldValue.unit };
                                } else {
                                    adapter.log.warn("status[" + dataIndex + "," + fieldIndex + "] has no id");
                                    adapter.log.debug(JSON.stringify(fieldValue));
                                }
                            });
                            result[dataIndex] = { dataId: dataValue.id, fieldIds: newList };
                        } else {
                            adapter.log.warn("status[" + dataIndex + "] has no fields/is not an array");
                            adapter.log.debug(JSON.stringify(dataValue));
                        }
                    } else {
                        adapter.log.warn("status[" + dataIndex + "] has no id");
                        adapter.log.debug(JSON.stringify(dataValue));
                    }
                });
            } else {
                adapter.log.warn("status is not an array");
                adapter.log.debug(JSON.stringify(statusJson.data));
            }
        } else {
            adapter.log.warn("status data without status field");
            adapter.log.debug(JSON.stringify(statusJson));
        }
        adapter.log.debug(JSON.stringify(result));
        return result;
    }

    updateUnit(pathString, unit) {
        const adapter = this;
        this.getObject(pathString, function (err, obj) {
            if (err) adapter.log.error('Error "' + err + '" reading object ' + pathString + " for unit");
            else {
                if (obj && obj.common && obj.common.unit !== unit) {
                    adapter.extendObject(pathString, {
                        type: "state",
                        common: {
                            unit: unit,
                        },
                    });
                }
            }
        });
    }

    updateName(pathString, name) {
        const adapter = this;
        this.getObject(pathString, function (err, obj) {
            if (err) adapter.log.error('Error "' + err + '" reading object ' + pathString + " for name");
            else {
                if (obj && obj.common && obj.common.name !== name) {
                    adapter.extendObject(pathString, {
                        type: "channel",
                        common: {
                            name: name,
                        },
                    });
                }
            }
        });
    }

    setVehicleStatus(vin, url, body, contentType, secToken) {
        return new Promise((resolve, reject) => {
            url = this.replaceVarInUrl(url, vin);
            this.log.debug(body);
            this.log.debug(contentType);
            const headers = {
                "User-Agent": this.userAgent,
                "X-App-Version": this.xappversion,
                "X-App-Name": this.xappname,
                Authorization: "Bearer " + this.config.vwatoken,
                "Accept-charset": "UTF-8",
                "Content-Type": contentType,
                Accept:
                    "application/json, application/vnd.vwg.mbb.ChargerAction_v1_0_0+xml,application/vnd.volkswagenag.com-error-v1+xml,application/vnd.vwg.mbb.genericError_v1_0_2+xml, application/vnd.vwg.mbb.RemoteStandheizung_v2_0_0+xml, application/vnd.vwg.mbb.genericError_v1_0_2+xml,application/vnd.vwg.mbb.RemoteLockUnlock_v1_0_0+xml,*/*",
            };
            if (secToken) {
                headers["x-mbbSecToken"] = secToken;
            }

            request.post(
                {
                    url: url,
                    headers: headers,
                    body: body,
                    followAllRedirects: true,
                    gzip: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        body && this.log.error(body);
                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug(JSON.stringify(body));
                        if (body.indexOf("<error>") !== -1) {
                            this.log.error("Error response try to refresh token " + url);
                            this.log.error(JSON.stringify(body));
                            this.refreshToken(true).catch((err) => {
                                this.log.error("Refresh Token was not successful");
                            });
                            reject(err);
                            return;
                        }
                        resolve();
                        this.log.info(body);
                    } catch (err) {
                        this.log.error(err);
                        this.log.error(err.stack);
                        reject(err);
                    }
                }
            );
        });
    }

    hasParkingPosition(vin) {
        const list = Array.isArray(this.vehicles) ? this.vehicles : (this.vehicles && Array.isArray(this.vehicles.data) ? this.vehicles.data : []);
        if (!Array.isArray(list)) return false;

        const vehicle = list.find(v => v && v.vin === vin);
        if (!vehicle || !Array.isArray(vehicle.capabilities)) return false;

        return vehicle.capabilities.some(c => c && c.id === "parkingPosition");
    }

    setVehicleStatusv2(vin, url, body, contentType, secToken) {
        return new Promise((resolve, reject) => {
            url = this.replaceVarInUrl(url, vin);
            this.log.debug(JSON.stringify(body));
            this.log.debug(contentType);
            const headers = {
                "User-Agent": this.userAgent,
                "X-App-Version": this.xappversion,
                "X-App-Name": this.xappname,
                Authorization: "Bearer " + this.config.vwatoken,
                "Accept-charset": "UTF-8",
                "Content-Type": contentType,
                Accept:
                    "application/json, application/vnd.vwg.mbb.ChargerAction_v1_0_0+xml,application/vnd.volkswagenag.com-error-v1+xml,application/vnd.vwg.mbb.genericError_v1_0_2+xml, application/vnd.vwg.mbb.RemoteStandheizung_v2_0_0+xml, application/vnd.vwg.mbb.genericError_v1_0_2+xml,application/vnd.vwg.mbb.RemoteLockUnlock_v1_0_0+xml,*/*",
            };
            if (secToken) {
                headers["x-mbbSecToken"] = secToken;
            }

            request.post(
                {
                    url: url,
                    headers: headers,
                    body: body,
                    followAllRedirects: true,
                    gzip: true,
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode.toString());
                        reject(err);
                        return;
                    }
                    try {
                        this.log.debug(JSON.stringify(body));
                        if (body.indexOf("<error>") !== -1) {
                            this.log.error("Error response try to refresh token " + url);
                            this.log.error(JSON.stringify(body));
                            this.refreshToken(true).catch((err) => {
                                this.log.error("Refresh Token was not successful");
                            });
                            reject(err);
                            return;
                        }
                        this.log.info(body);
                    } catch (err) {
                        this.log.error(err);
                        this.log.error(err.stack);
                        reject(err);
                    }
                }
            );
        });
    }

    getCodeChallenge() {
        let hash = "";
        let result = "";
        const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        result = "";
        for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
        result = Buffer.from(result).toString("base64");
        result = result.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        hash = crypto.createHash("sha256").update(result).digest("base64");
        hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

        return [result, hash];
    }

    getCodeChallengev2() {
        let hash = "";
        let result = "";
        const chars = "0123456789abcdef";
        result = "";
        for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
        hash = crypto.createHash("sha256").update(result).digest("base64");
        hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

        return [result, hash];
    }

    getNonce() {
        const timestamp = Date.now();
        let hash = crypto.createHash("sha256").update(timestamp.toString()).digest("base64");
        hash = hash.slice(0, hash.length - 1);
        return hash;
    }

    toHexString(byteArray) {
        return Array.prototype.map
            .call(byteArray, function (byte) {
                return ("0" + (byte & 0xff).toString(16).toUpperCase()).slice(-2);
            })
            .join("");
    }

    toByteArray(hexString) {
        const result = [];
        for (let i = 0; i < hexString.length; i += 2) {
            result.push(parseInt(hexString.substr(i, 2), 16));
        }
        return result;
    }

    stringIsAValidUrl(s) {
        try {
            new URL(s);
            return true;
        } catch (err) {
            return false;
        }
    }

    randomString(length) {
        let result = "";
        const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    toCammelCase(string) {
        return string.replace(/-([a-z])/g, function (g) {
            return g[1].toUpperCase();
        });
    }

    extractHidden(body) {
        const returnObject = {};
        let matches;
        if (body.matchAll) {
            matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
        } else {
            this.log.warn("The adapter needs in the future NodeJS v12. https://forum.iobroker.net/topic/22867/how-to-node-js-f%C3%BCr-iobroker-richtig-updaten");
            matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
        }
        for (const match of matches) {
            returnObject[match[1]] = match[2];
        }
        return returnObject;
    }

    matchAll(re, str) {
        let match;
        const matches = [];

        while ((match = re.exec(str))) {
            // add all matched groups
            matches.push(match);
        }

        return matches;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(/*callback*/) {
        try {
            this.log.debug("cleaned everything up...");
            clearInterval(this.refreshTokenInterval);
            clearInterval(this.vwrefreshTokenInterval);
            clearInterval(this.updateInterval);
            clearInterval(this.fupdateInterval);
            clearTimeout(this.refreshTokenTimeout);
            //callback();
            this.log.debug("onUnload: Success");
        } catch (e) {
            //callback();
            this.log.error("onUnload: Error");
        }
    }
}

module.exports.VwWeConnect = VwWeConnect;
module.exports.Log = Log;

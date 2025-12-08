"use strict";

// Cleaned VW WeConnect ID API (BFF-based, no legacy WeCharge / MBB / FS-Car flows)
const EventEmitter = require("events").EventEmitter;
const request = require("request");
const express = require("express");
const mysql = require("mysql2");

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
        if (this.logLevel === "DEBUG") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("DEBUG", pMessage);
            } else {
                console.log("DEBUG: " + pMessage);
            }
        }
    }
    error(pMessage) {
        if (this.logLevel !== "NONE") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("ERROR", pMessage);
            } else {
                console.log("ERROR: " + pMessage);
            }
        }
    }
    info(pMessage) {
        if (this.logLevel === "DEBUG" || this.logLevel === "INFO") {
            if (this.logTargetExternal) {
                module.exports.idLogEmitter.emit("INFO", pMessage);
            } else {
                console.log("INFO:  " + pMessage);
            }
        }
    }
    warn(pMessage) {
        if (
            this.logLevel === "DEBUG" ||
            this.logLevel === "INFO" ||
            this.logLevel === "WARN"
        ) {
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
        db: null,
        checkSafeStatusTimeout: 5
    };

    currSession = {
        vin: "n/a"
    };

    constructor() {
        this.boolFinishIdData = false;
        this.boolFinishVehicles = false;

        this.log = new Log(this.config.logLevel);
        this.jar = request.jar();
        this.userAgent = "Volkswagen/3.51.1-android/14";

        // NEW: guarded login state
        this.isLoggingIn = false;
        this.loginPromise = null;

        this.updateInterval = null;

        this.vinArray = [];
        this.etags = {};
    }

    finishedReading() {
        return (
            (this.boolFinishIdData || this.config.chargerOnly) &&
            this.boolFinishVehicles
        );
    }

    setCredentials(pUser, pPass) {
        this.config.user = pUser;
        this.config.password = pPass;
        this.config.interval = 0.5;
        this.config.checkSafeStatusTimeout = 5; // minutes
    }

    setConfig(pType) {
        if (pType === "idCharger") {
            this.config.type = "id";
            this.config.chargerOnly = true;
        } else {
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
            this.setDatabase("10.55.0.1");
        } else {
            this.log.error(
                "VIN <" + pVin + "> is unknown. Active VIN is still <" + this.currSession.vin + ">."
            );
        }
    }

    setDatabase(pHost) {
        this.config.db = mysql.createPool({
            host: pHost,
            user: this.config.user,
            password: this.config.password,
            database: "weconnect",
            waitForConnections: true,
            connectionLimit: 10
        });
    }

    restart() {
        // hook for external restart logic if needed
    }

    stopCharging() {
        return new Promise((resolve, reject) => {
            this.log.debug("stopCharging >>");
            this.setIdRemote(this.currSession.vin, "charging", "stop", "")
                .then(() => {
                    this.log.debug("stopCharging successful");
                    resolve();
                })
                .catch((error) => {
                    this.log.error("stopCharging failed");
                    reject(error);
                });
            this.log.debug("stopCharging <<");
        });
    }

    setChargingSetting(setting, value) {
        return new Promise((resolve, reject) => {
            this.log.debug("setChargerSetting " + setting + " to " + value + " >>");
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }

            switch (setting) {
                case "targetSOC":
                    if (value >= 50 && value <= 100) {
                        this.config.pendingRequests++;
                        this.config.targetSOC = value;
                    } else {
                        this.log.debug(
                            "setChargerSetting " +
                            setting +
                            " value " +
                            value +
                            " out of bounds >"
                        );
                    }
                    break;
                case "chargeCurrent":
                    if (value === "maximum" || value === "reduced") {
                        this.config.pendingRequests++;
                        this.config.chargeCurrent = value;
                    } else {
                        this.log.debug(
                            "setChargerSetting " +
                            setting +
                            " incorrect value " +
                            value +
                            "  >>"
                        );
                    }
                    break;
                case "autoUnlockPlug":
                    this.config.pendingRequests++;
                    this.config.autoUnlockPlug = value;
                    break;
                default:
                    this.log.debug(
                        "setChargerSetting " + setting + " not implemented" + " >>"
                    );
                    break;
            }

            this.setIdRemote(this.currSession.vin, "charging", "settings")
                .then(() => {
                    this.log.info("setIdRemote succeeded");
                    this.config.pendingRequests = Math.max(
                        this.config.pendingRequests - 1,
                        0
                    );
                    resolve();
                })
                .catch((error) => {
                    this.log.error("setIdRemote failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                });
            this.log.debug("setChargerSettings <<");
        });
    }

    setChargingSettings(pTargetSOC, pChargeCurrent) {
        return new Promise((resolve, reject) => {
            this.log.debug(
                "setChargerSettings TargetSOC to " +
                pTargetSOC +
                "%, chargeCurrent to " +
                pChargeCurrent +
                " >>"
            );
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }
            if (pTargetSOC >= 50 && pTargetSOC <= 100) {
                this.config.pendingRequests++;
                this.config.targetSOC = pTargetSOC;
            }
            if (pChargeCurrent === "maximum" || pChargeCurrent === "reduced") {
                this.config.pendingRequests++;
                this.config.chargeCurrent = pChargeCurrent;
            }

            this.setIdRemote(this.currSession.vin, "charging", "settings")
                .then(() => {
                    this.log.info(
                        "Target SOC set to " + this.config.targetSOC + "%."
                    );
                    this.log.info(
                        "Charging current set to " + this.config.chargeCurrent + "."
                    );
                    this.config.pendingRequests = Math.max(
                        this.config.pendingRequests - 1,
                        0
                    );
                    resolve();
                })
                .catch((error) => {
                    this.log.error("setting SOC and charge current failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                });
            this.log.debug("setChargerSettings <<");
        });
    }

    startCharging() {
        return new Promise((resolve, reject) => {
            this.log.debug("startCharging >>");
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }

            this.setIdRemote(this.currSession.vin, "charging", "start")
                .then(() => {
                    this.log.debug("startCharging successful");
                    resolve();
                })
                .catch((error) => {
                    this.log.error("startCharging failed");
                    reject(error);
                });

            this.log.debug("startCharging <<");
        });
    }

    stopClimatisation() {
        return new Promise((resolve, reject) => {
            this.log.debug("stopClimatisation >>");
            this.setIdRemote(this.currSession.vin, "climatisation", "stop", "")
                .then(() => {
                    this.log.debug("stopClimatisation successful");
                    resolve();
                })
                .catch((error) => {
                    this.log.error("stopClimatisation failed");
                    reject(error);
                });
            this.log.debug("stopClimatisation <<");
        });
    }

    setDestination(destination) {
        return new Promise((resolve, reject) => {
            this.log.debug("setDestination >>");
            this.setIdRemote(this.currSession.vin, "destinations", "", destination)
                .then(() => {
                    this.log.debug("setDestination successful");
                    resolve();
                })
                .catch((error) => {
                    this.log.error("setDestination failed");
                    reject(error);
                });
            this.log.debug("setDestination <<");
        });
    }

    startClimatisation() {
        return new Promise((resolve, reject) => {
            this.log.debug(
                "startClimatisation with " + this.config.targetTempC + "°C >>"
            );
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }

            this.setIdRemote(this.currSession.vin, "climatisation", "start", "")
                .then(() => {
                    this.log.debug("startClimatisation successful");
                    resolve();
                })
                .catch((error) => {
                    this.log.error("startClimatisation failed");
                    reject(error);
                });
            this.log.debug("startClimatisation <<");
        });
    }

    setClimatisationSetting(pSetting, pValue) {
        return new Promise((resolve, reject) => {
            this.log.debug(
                "setClimatisationSetting with " +
                pSetting +
                " " +
                pValue +
                " >>"
            );
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }

            this.config.pendingRequests++;
            switch (pSetting) {
                case "climatizationAtUnlock":
                    this.config.climatizationAtUnlock = pValue;
                    break;
                case "climatisationWindowHeating":
                    this.config.climatisationWindowHeating = pValue;
                    break;
                case "climatisationFrontLeft":
                    this.config.climatisationFrontLeft = pValue;
                    break;
                case "climatisationFrontRight":
                    this.config.climatisationFrontRight = pValue;
                    break;
                default:
                    break;
            }

            this.setIdRemote(this.currSession.vin, "climatisation", "settings", "")
                .then(() => {
                    this.log.debug("setClimatisationSetting successful");
                    this.config.pendingRequests = Math.max(
                        this.config.pendingRequests - 1,
                        0
                    );
                    resolve();
                })
                .catch((error) => {
                    this.log.error("setClimatisationSetting failed");
                    this.config.pendingRequests = 0;
                    reject(error);
                });
            this.log.debug("setClimatisationSetting <<");
        });
    }

    setClimatisation(pTempC) {
        return new Promise((resolve, reject) => {
            this.log.debug("setClimatisation with " + pTempC + "°C >>");
            if (!this.finishedReading()) {
                this.log.info(
                    "Reading necessary data not finished yet. Please try again."
                );
                reject(new Error("Data not ready"));
                return;
            }
            if (!this.vinArray.includes(this.currSession.vin)) {
                this.log.error(
                    "Unknown VIN, aborting. Use setActiveVin to set a valid VIN."
                );
                reject(new Error("Unknown VIN"));
                return;
            }
            if (pTempC < 16 || pTempC > 27) {
                this.log.info(
                    "Invalid temperature, setting 20°C as default"
                );
                pTempC = 20;
            }
            this.config.pendingRequests++;
            this.config.targetTempC = pTempC;

            this.setIdRemote(this.currSession.vin, "climatisation", "settings", "")
                .then(() => {
                    this.log.debug("setClimatisation successful");
                    this.config.pendingRequests = Math.max(
                        this.config.pendingRequests - 1,
                        0
                    );
                    resolve();
                })
                .catch((error) => {
                    this.log.error("setClimatisation failed");
                    this.config.pendingRequests = 0;
                    reject(error);
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
        app.get("/status", (req, res) => {
            if (typeof this.idData !== "undefined") {
                res.json(this.idData);
            } else {
                res.status(200).end();
            }
        });

        app.listen(port, () => {
            this.log.info("API server is running on port " + port);
        });
    }

    async getData() {
        this.boolFinishIdData = false;
        this.boolFinishVehicles = false;

        if (this.config.interval === 0) {
            this.log.info("Interval of 0 is not allowed, reset to 1");
            this.config.interval = 1;
        }

        const donePromise = new Promise((resolve) => {
            const finishedReadingInterval = setInterval(() => {
                if (this.finishedReading()) {
                    clearInterval(finishedReadingInterval);
                    resolve("done");
                }
            }, 1000);
        });

        this.type = "Id";
        this.country = "DE";
        this.clientId =
            "a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com";
        this.scope = "openid profile badge cars dealers birthdate vin";
        this.redirect = "weconnect://authenticated";
        this.xrequest = "com.volkswagen.weconnect";
        this.responseType = "code id_token token";

        try {
            await this.login();
            this.log.info("Login successful");

            await this.getPersonalData();
            await this.getVehicles();

            this.vinArray.forEach((vin) => {
                this.getIdStatus(vin).catch(() => {
                    this.log.debug("get id status Failed");
                });
                this.getIdParkingPosition(vin).catch(() => {
                    this.log.debug("get id parking position Failed");
                });
            });

            this.updateInterval = setInterval(() => {
                this.updateStatus();
            }, this.config.interval * 60 * 1000);
        } catch (err) {
            this.log.error("Login or initial data fetch failed");
        }

        await donePromise;
        this.log.debug("getData END");
    }

    _req(opts) {
        return new Promise((resolve, reject) => {
            request(opts, (err, resp, body) => {
                if (err) return reject(err);
                resolve({ resp, body });
            });
        });
    }

    async _handleConsentPage(url, jar) {
        const adapter = this;
        const ua = this.userAgent || "Volkswagen/3.51.1-android/14";

        adapter.log.debug("[_handleConsentPage] GET " + url);

        // GET the consent page
        let { resp, body } = await this._req({
            method: "GET",
            url,
            jar,
            followRedirect: false,
            gzip: true,
            headers: {
                "User-Agent": ua,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate"
            }
        });

        const status = resp.statusCode;
        if (status === 500) {
            throw new Error("Temporary server error during consent flow");
        }
        if (status !== 200) {
            throw new Error("Unexpected status code during consent flow: " + status);
        }

        // Reuse your existing extractHidden() helper
        const hiddenFields = this.extractHidden(body || "");
        adapter.log.debug("[_handleConsentPage] Hidden fields: " + JSON.stringify(hiddenFields));

        // Strip query from URL, like Python does
        let postUrl = url;
        try {
            const u = new URL(url);
            u.search = "";
            postUrl = u.toString();
        } catch (e) {
            // fallback: strip by hand
            const qIdx = url.indexOf("?");
            if (qIdx >= 0) {
                postUrl = url.substring(0, qIdx);
            }
        }

        // Build x-www-form-urlencoded body from hidden fields
        const formBody = Object.keys(hiddenFields)
            .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(hiddenFields[k]))
            .join("&");

        adapter.log.debug("[_handleConsentPage] POST consent to " + postUrl);

        ({ resp, body } = await this._req({
            method: "POST",
            url: postUrl,
            jar,
            followRedirect: false,
            gzip: true,
            headers: {
                "User-Agent": ua,
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate"
            },
            body: formBody
        }));

        const postStatus = resp.statusCode;
        if (postStatus === 500) {
            throw new Error("Temporary server error during consent POST");
        }
        if (!(postStatus === 302 || postStatus === 303)) {
            throw new Error("Forwarding expected (302/303) after consent POST, got " + postStatus);
        }

        const loc = resp.headers.location;
        if (!loc) {
            throw new Error("Forwarding without Location in consent response");
        }

        const nextUrl = new URL(loc, postUrl).toString();
        adapter.log.debug("[_handleConsentPage] Next URL after consent: " + nextUrl);
        return nextUrl;
    }

    async _handleNewAuthFlow(startUrl, jar) {
        const adapter = this;
        const ua = this.userAgent || "Volkswagen/3.51.1-android/14";

        let url = startUrl;
        let resp, body;

        // === Initial fetch of authorization page (max 5 redirects) ===
        let maxInitialRedirects = 5;
        while (maxInitialRedirects > 0) {
            // If we already got a custom scheme, just return it
            if (url.startsWith("weconnect://")) {
                adapter.log.debug("[_handleNewAuthFlow] Found custom scheme during initial fetch: " + url);
                return url;
            }

            adapter.log.debug("[_handleNewAuthFlow] GET " + url);

            ({ resp, body } = await this._req({
                method: "GET",
                url,
                jar,
                followRedirect: false,
                gzip: true,
                headers: {
                    "User-Agent": ua,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept-Encoding": "gzip, deflate"
                }
            }));

            const status = resp.statusCode;

            if (status === 200) {
                break;
            }

            if (status === 302 || status === 303) {
                const loc = resp.headers.location;
                if (!loc) {
                    throw new Error("Forwarding without Location in headers (initial auth fetch)");
                }
                url = new URL(loc, url).toString();
                maxInitialRedirects--;
                continue;
            }

            throw new Error("Failed to fetch authorization page, status=" + status);
        }

        if (maxInitialRedirects === 0) {
            throw new Error("Too many redirects while fetching authorization page");
        }

        // === Extract state token from HTML ===
        const stateMatch = body && body.match(/<input[^>]*name="state"[^>]*value="([^"]*)"/);
        const state = stateMatch && stateMatch[1];
        if (!state) {
            throw new Error("Could not find state token in authorization page");
        }

        // === POST username/password/state to /u/login?state=... ===
        const loginUrl = "https://identity.vwgroup.io/u/login?state=" + encodeURIComponent(state);
        const loginFormBody =
            "username=" + encodeURIComponent(this.config.user) +
            "&password=" + encodeURIComponent(this.config.password) +
            "&state=" + encodeURIComponent(state);

        adapter.log.debug("[_handleNewAuthFlow] POST credentials to " + loginUrl);

        ({ resp, body } = await this._req({
            method: "POST",
            url: loginUrl,
            jar,
            followRedirect: false,
            gzip: true,
            headers: {
                "User-Agent": ua,
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate"
            },
            body: loginFormBody
        }));

        const statusLogin = resp.statusCode;
        if (!(statusLogin === 302 || statusLogin === 303)) {
            throw new Error("Login failed with status code: " + statusLogin);
        }
        if (!resp.headers.location) {
            throw new Error("No Location header in login response");
        }

        let redirectUrl = resp.headers.location;
        adapter.log.debug("[_handleNewAuthFlow] After-login redirect: " + redirectUrl);

        // === Follow redirects until weconnect://authenticated... (max 10 redirects) ===
        let maxDepth = 10;
        while (maxDepth > 0) {
            adapter.log.debug("[_handleNewAuthFlow] Redirect loop depth=" + maxDepth + " url=" + redirectUrl);

            // Final callbacks
            if (redirectUrl.startsWith("weconnect://authenticated")) {
                adapter.log.debug("[_handleNewAuthFlow] Reached OAuth callback URL");
                return redirectUrl;
            }
            if (redirectUrl.startsWith("weconnect://")) {
                adapter.log.info("[_handleNewAuthFlow] Found custom scheme URL: " + redirectUrl);
                return redirectUrl;
            }

            // Handle consent / terms-and-conditions pages (like Python)
            if (redirectUrl.indexOf("terms-and-conditions") !== -1) {
                adapter.log.info("[_handleNewAuthFlow] Detected terms-and-conditions page at: " + redirectUrl);
                redirectUrl = await this._handleConsentPage(
                    redirectUrl.startsWith("http")
                        ? redirectUrl
                        : "https://identity.vwgroup.io" + redirectUrl,
                    jar
                );
                // After consent, continue the redirect loop with the new URL
                maxDepth--;
                continue;
            }

            const absUrl = redirectUrl.startsWith("http")
                ? redirectUrl
                : "https://identity.vwgroup.io" + redirectUrl;

            adapter.log.debug("[_handleNewAuthFlow] GET " + absUrl);

            ({ resp, body } = await this._req({
                method: "GET",
                url: absUrl,
                jar,
                followRedirect: false,
                gzip: true,
                headers: {
                    "User-Agent": ua,
                    "Accept": "*/*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept-Encoding": "gzip, deflate"
                }
            }));

            const status = resp.statusCode;
            if (status === 500) {
                throw new Error("Temporary server error during new auth flow");
            }

            if (!resp.headers.location) {
                // Might be a final page, check again if it contains a custom scheme
                if (absUrl.startsWith("weconnect://")) {
                    adapter.log.info("[_handleNewAuthFlow] Reached custom scheme without Location");
                    return absUrl;
                }
                throw new Error("No Location header in redirect (new auth flow), status=" + status);
            }

            redirectUrl = resp.headers.location;
            adapter.log.debug("[_handleNewAuthFlow] Next redirect: " + redirectUrl);

            // Check again for final callbacks before next iteration
            if (redirectUrl.startsWith("weconnect://authenticated")) {
                adapter.log.debug("[_handleNewAuthFlow] Reached OAuth callback URL after redirect");
                return redirectUrl;
            }
            if (redirectUrl.startsWith("weconnect://")) {
                adapter.log.info("[_handleNewAuthFlow] Found custom scheme URL after redirect: " + redirectUrl);
                return redirectUrl;
            }

            maxDepth--;
        }

        throw new Error("Too many redirects in new auth flow");
    }



    async login() {
        this.config.disableRefresh = false;
        const jar = request.jar();
        this._jar = jar;
        const adapter = this;

        // =============================
        // STEP 0 — PKCE GENERATION
        // =============================

        const crypto = require("crypto");

        // Random 64-char verifier
        const codeVerifier = [...Array(64)]
            .map(() => Math.random().toString(36)[2])
            .join("");
        this.codeVerifier = codeVerifier;

        // Base64URL(SHA256(verifier))
        const codeChallenge = crypto
            .createHash("sha256")
            .update(codeVerifier)
            .digest("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

        // =============================
        // STEP 1 — BFF AUTHORIZE
        // =============================

        const nonce = Math.random().toString(36).slice(2);
        const authorizeInit =
            "https://emea.bff.cariad.digital/user-login/v1/authorize" +
            "?nonce=" + encodeURIComponent(nonce) +
            "&redirect_uri=" + encodeURIComponent("weconnect://authenticated") +
            "&code_challenge=" + encodeURIComponent(codeChallenge) +
            "&code_challenge_method=S256";

        this.log.debug("Step 1: GET authorize -> " + authorizeInit);

        let { resp } = await this._req({
            method: "GET",
            url: authorizeInit,
            jar,
            followRedirect: false,
            gzip: true,
            headers: {
                "User-Agent": this.userAgent
            }
        });

        if (!resp.headers.location) {
            throw new Error("Missing Location header from BFF authorize");
        }

        const firstRedirect = resp.headers.location;
        this.log.debug("Step 2: First redirect -> " + firstRedirect);

        // =============================
        // STEP 2 — FULL NEW AUTH FLOW
        // =============================

        const callbackUrl = await this._handleNewAuthFlow(firstRedirect, jar);

        if (!callbackUrl || !callbackUrl.startsWith("weconnect://")) {
            this.log.error("Unexpected callback URL: " + callbackUrl);
            throw new Error("Unexpected callback URL");
        }

        this.log.debug("Step 3: Final redirect reached -> extracting tokens");

        // =============================
        // STEP 3 — TRANSFORM CUSTOM SCHEME
        // =============================

        function makeHttpFromCustomScheme(cbUrl) {
            const hashIdx = cbUrl.indexOf("#");
            const qIdx = cbUrl.indexOf("?");

            let qs = "";
            if (hashIdx >= 0) qs = cbUrl.substring(hashIdx + 1);
            else if (qIdx >= 0) qs = cbUrl.substring(qIdx + 1);
            else return null;

            return "https://egal?" + qs;
        }

        const httpUrl = makeHttpFromCustomScheme(callbackUrl);
        if (!httpUrl) {
            adapter.log.error("Callback URL has no query or fragment: " + callbackUrl);
            throw new Error("Callback URL has no parameters");
        }

        this.log.debug("Transformed callback URL -> " + httpUrl);

        let urlObj;
        try { urlObj = new URL(httpUrl); }
        catch (e) {
            this.log.error("Failed to parse transformed callback URL: " + httpUrl);
            throw e;
        }

        const params = urlObj.searchParams;
        const code = params.get("code");
        const id_token = params.get("id_token");
        const access_token = params.get("access_token");
        const state = params.get("state");

        if (!code || !id_token || !access_token || !state) {
            this.log.error("Missing tokens from callback");
            this.log.error("Original: " + callbackUrl);
            this.log.error("Transformed: " + httpUrl);
            throw new Error("Missing required tokens from callback");
        }

        // =============================
        // STEP 4 — BFF TOKEN EXCHANGE
        // =============================

        this.log.debug("Step 4: Token exchange via Cariad BFF");

        const loginBody = JSON.stringify({
            state,
            id_token,
            redirect_uri: "weconnect://authenticated",
            region: "emea",
            access_token,
            authorizationCode: code,
            code_verifier: this.codeVerifier
        });

        const headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
            "user-agent": this.userAgent,
            "accept-language": "de-de",
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "x-android-package-name": "com.volkswagen.weconnect"
        };

        const { body: tokenResp } = await this._req({
            method: "POST",
            url: "https://emea.bff.cariad.digital/user-login/login/v1",
            jar,
            followRedirect: false,
            gzip: true,
            headers,
            body: loginBody
        });

        let tokenData;
        try {
            tokenData = JSON.parse(tokenResp);
        } catch (e) {
            this.log.error("Token JSON parse failed");
            this.log.error(tokenResp);
            throw e;
        }

        const accessToken = tokenData.accessToken || tokenData.access_token;
        const refreshToken = tokenData.refreshToken || tokenData.refresh_token;
        const idToken = tokenData.idToken || tokenData.id_token;

        if (!accessToken || !refreshToken || !idToken) {
            this.log.error("Token response incomplete");
            this.log.error(tokenResp);
            throw new Error("Token response incomplete");
        }

        // =============================
        // STEP 5 — STORE TOKENS
        // =============================

        this._accessToken = accessToken;
        this._refreshToken = refreshToken;
        this._idToken = idToken;

        this.config.atoken = accessToken;
        this.config.rtoken = refreshToken;
        this.config.idtoken = idToken;

        this.log.debug("login successful");
        return true;
    }

    /**
     * Zorgt dat er nooit meer dan één login tegelijk draait.
     * Andere callers wachten op dezelfde promise.
     */
    async _loginOnceGuarded(reason) {
        if (this.isLoggingIn && this.loginPromise) {
            this.log.debug("[LoginGuard] Waiting for ongoing login (" + reason + ")");
            return this.loginPromise;
        }

        this.isLoggingIn = true;
        this.loginPromise = (async () => {
            try {
                this.log.debug("[LoginGuard] Starting full login (" + reason + ")");
                await this.login();
                this.log.debug("(Re-)login completed (" + reason + ")");
            } catch (e) {
                this.log.error("[LoginGuard] Login failed (" + reason + "): " + e);
                throw e;
            } finally {
                this.isLoggingIn = false;
                this.loginPromise = null;
            }
        })();

        return this.loginPromise;
    }



    updateStatus() {
        this.vinArray.forEach((vin) => {
            if (vin === this.currSession.vin) {
                this.getIdStatus(vin).catch((err) => {
                    this.log.debug("get id status Failed: " + err);
                });
                this.getIdParkingPosition(vin).catch((err) => {
                    this.log.debug("get id parking position Failed: " + err);
                });
            }
        });
    }


    getPersonalData() {
        return new Promise((resolve) => {
            this.log.debug("START getPersonalData()");
            resolve();
        });
    }

    getVehicles() {
        return new Promise((resolve, reject) => {
            this.log.debug("START getVehicles");

            const url = "https://emea.bff.cariad.digital/vehicle/v1/vehicles";
            const headers = {
                accept: "*/*",
                "content-type": "application/json",
                "content-version": "1",
                "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                "user-agent": this.userAgent,
                "accept-language": "de-de",
                authorization: "Bearer " + this.config.atoken
            };

            request.get(
                {
                    url,
                    headers,
                    followAllRedirects: true,
                    gzip: true,
                    json: true
                },
                (err, resp, body) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        err && this.log.error(err);
                        resp && this.log.error(resp.statusCode);
                        reject(err || new Error("Vehicle request failed"));
                        return;
                    }
                    try {
                        if (body.errorCode) {
                            this.log.error(JSON.stringify(body));
                            reject(new Error("Vehicle response error"));
                            return;
                        }
                        this.log.debug("getVehicles: " + JSON.stringify(body));
                        this.vehicles = body;
                        this.boolFinishVehicles = true;

                        const list = Array.isArray(body.data)
                            ? body.data
                            : [];

                        if (list.length > 0) {
                            list.forEach((element) => {
                                const vin = element.vin;
                                if (!vin) {
                                    this.log.info(
                                        "No vin found for:" +
                                        JSON.stringify(element)
                                    );
                                    return;
                                }
                                if (!this.vinArray.includes(vin)) {
                                    this.vinArray.push(vin);
                                }
                            });
                        } else {
                            this.log.error("No data in server response");
                        }
                        resolve();
                    } catch (e) {
                        this.log.error(e);
                        this.log.error(e.stack);
                        this.log.error(
                            "Not able to find vehicle, did you choose the correct type?"
                        );
                        reject(e);
                    }
                }
            );
        });
    }

    async checkSafeFlag(timeout) {
        return new Promise((resolve, reject) => {
            let counter = 0;
            const checkInterval = setInterval(() => {
                if (
                    this.idData &&
                    this.idData.access &&
                    this.idData.access.accessStatus &&
                    this.idData.access.accessStatus.value &&
                    this.idData.access.accessStatus.value.overallStatus ===
                    "safe"
                ) {
                    clearInterval(checkInterval);
                    this.config.unSafe = false;
                    module.exports.idStatusEmitter.emit(
                        "statusNotSafe",
                        false
                    );
                    reject("safe");
                    return;
                }
                if (counter++ >= timeout / 2) {
                    clearInterval(checkInterval);
                    this.config.unSafe = true;
                    module.exports.idStatusEmitter.emit(
                        "statusNotSafe",
                        true
                    );
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
            let counter = 0;
            const checkInterval = setInterval(() => {
                const charging = this.idData && this.idData.charging;
                const plugStatus =
                    charging && charging.plugStatus && charging.plugStatus.value;
                if (
                    plugStatus &&
                    (plugStatus.externalPower === "ready" ||
                        plugStatus.externalPower === "active")
                ) {
                    clearInterval(checkInterval);
                    this.config.noExternalPower = false;
                    module.exports.idStatusEmitter.emit(
                        "noExternalPower",
                        false
                    );
                    reject("powerReady");
                    return;
                }
                if (counter++ >= timeout / 2) {
                    clearInterval(checkInterval);
                    this.config.noExternalPower = true;
                    module.exports.idStatusEmitter.emit(
                        "noExternalPower",
                        true
                    );
                    resolve();
                    return;
                }
            }, 30 * 1000);
        }).catch((err) => {
            this.log.debug(err);
        });
    }

    async logToDb() {
        if (!this.currSession || !this.currSession.vin) {
            throw new Error("VIN missing");
        }
        if (!this.config.db) {
            return null;
        }

        try {
            const odoRaw =
                this.idData?.measurements?.odometerStatus?.value?.odometer;
            const socRaw =
                this.idData?.charging?.batteryStatus?.value?.currentSOC_pct;
            const rngRaw =
                this.idData?.charging?.batteryStatus?.value
                    ?.cruisingRangeElectric_km;
            const latRaw = this.idParkingPosition?.data?.lat;
            const lonRaw = this.idParkingPosition?.data?.lon;

            const toNum = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };

            const sql =
                "INSERT INTO travel (vin, odo, soc, rng, lat, lon) VALUES (?, ?, ?, ?, ?, ?)";

            const params = [
                this.currSession.vin || null,
                toNum(odoRaw),
                toNum(socRaw),
                toNum(rngRaw),
                toNum(latRaw),
                toNum(lonRaw)
            ];

            const [result] = await this.config.db
                .promise()
                .execute(sql, params);
            return (result && result.insertId) || null;
        } catch (err) {
            console.error("DB error:", err);
            return null;
        }
    }

    async runEventEmitters() {
        module.exports.idStatusEmitter.emit("eventRunStarted");
        if (typeof this.idDataOld === "undefined") {
            return;
        }

        try {
            // parking
            if (
                this.idData.parking.data.carIsParked !==
                this.idDataOld.parking.data.carIsParked
            ) {
                if (this.config.db) {
                    await this.logToDb();
                }
                if (this.idData.parking.data.carIsParked) {
                    module.exports.idStatusEmitter.emit(
                        "positionUpdate",
                        this.idData.parking.data
                    );
                } else {
                    module.exports.idStatusEmitter.emit("positionUnknown");
                }
                module.exports.idStatusEmitter.emit(
                    "parked",
                    this.idData.parking.data.carIsParked
                );
                module.exports.idStatusEmitter.emit(
                    "notParked",
                    !this.idData.parking.data.carIsParked
                );
            }
            if (
                this.idData.parking.data.carIsParked &&
                this.idData.access.accessStatus.value.overallStatus !==
                "safe" &&
                (!this.idDataOld.parking.data.carIsParked ||
                    this.idDataOld.access.accessStatus.value
                        .overallStatus === "safe")
            ) {
                this.checkSafeFlag(this.config.checkSafeStatusTimeout);
            }

            if (
                this.idData.access.accessStatus.value.overallStatus ===
                "safe" &&
                this.idDataOld.access.accessStatus.value.overallStatus !==
                "safe"
            ) {
                module.exports.idStatusEmitter.emit(
                    "statusNotSafe",
                    false
                );
                this.config.unSafe = false;
            }

            if (
                this.idData.access.accessStatus.value.doorLockStatus !==
                "locked" &&
                this.idDataOld.access.accessStatus.value.doorLockStatus ===
                "locked"
            ) {
                module.exports.idStatusEmitter.emit("carLocked", false);
            }
            if (
                this.idData.access.accessStatus.value.doorLockStatus ===
                "locked" &&
                this.idDataOld.access.accessStatus.value.doorLockStatus !==
                "locked"
            ) {
                module.exports.idStatusEmitter.emit("carLocked", true);
            }

            // charging
            if (
                (this.idData.charging.chargingStatus.value.chargingState.includes(
                    "chargePurposeReached"
                ) ||
                    (this.idData.charging.chargingStatus.value
                        .chargingState !== "charging" &&
                        this.idData.charging.chargingSettings.value
                            .targetSOC_pct ===
                        this.idData.charging.batteryStatus.value
                            .currentSOC_pct)) &&
                this.idDataOld.charging.chargingStatus.value
                    .chargingState === "charging"
            ) {
                module.exports.idStatusEmitter.emit("chargePurposeReached");
            }
            if (
                this.idData.charging.chargingStatus.value
                    .chargingState === "charging" &&
                this.idDataOld.charging.chargingStatus.value
                    .chargingState !== "charging"
            ) {
                module.exports.idStatusEmitter.emit("chargingStarted");
            }
            if (
                this.idData.charging.chargingStatus.value
                    .chargingState !== "charging" &&
                this.idDataOld.charging.chargingStatus.value
                    .chargingState === "charging"
            ) {
                module.exports.idStatusEmitter.emit("chargingStopped");
            }
            if (
                this.idData.charging.batteryStatus.value.currentSOC_pct !==
                this.idDataOld.charging.batteryStatus.value.currentSOC_pct
            ) {
                module.exports.idStatusEmitter.emit(
                    "currentSOC",
                    this.idData.charging.batteryStatus.value
                        .currentSOC_pct
                );
            }
            if (
                this.idData.charging.batteryStatus.value
                    .cruisingRangeElectric_km !==
                this.idDataOld.charging.batteryStatus.value
                    .cruisingRangeElectric_km
            ) {
                module.exports.idStatusEmitter.emit(
                    "remainingRange",
                    this.idData.charging.batteryStatus.value
                        .cruisingRangeElectric_km
                );
            }
            if (
                this.idData.charging.plugStatus.value
                    .plugConnectionState === "connected" &&
                this.idDataOld.charging.plugStatus.value
                    .plugConnectionState === "disconnected"
            ) {
                this.checkPlugAndPower(this.config.checkSafeStatusTimeout);
            }

            if (
                (this.idData.charging.plugStatus.value
                    .plugConnectionState === "disconnected" &&
                    this.idDataOld.charging.plugStatus.value
                        .plugConnectionState === "connected") ||
                ((this.idData.charging.plugStatus.value.externalPower ===
                    "ready" ||
                    this.idData.charging.plugStatus.value
                        .externalPower === "active") &&
                    this.config.noExternalPower)
            ) {
                module.exports.idStatusEmitter.emit(
                    "noExternalPower",
                    false
                );
                this.config.noExternalPower = false;
            }

            if (
                this.idData.charging.chargingSettings.value
                    .targetSOC_pct !==
                this.idDataOld.charging.chargingSettings.value
                    .targetSOC_pct
            ) {
                module.exports.idStatusEmitter.emit("targetSOCupdated");
            }
            if (
                this.idData.charging.chargingSettings.value
                    .maxChargeCurrentAC !==
                this.idDataOld.charging.chargingSettings.value
                    .maxChargeCurrentAC
            ) {
                module.exports.idStatusEmitter.emit(
                    "reducedACupdated"
                );
            }
            if (
                this.idData.charging.chargingSettings.value
                    .autoUnlockPlugWhenCharged !==
                this.idDataOld.charging.chargingSettings.value
                    .autoUnlockPlugWhenCharged
            ) {
                module.exports.idStatusEmitter.emit(
                    "autoUnlockPlugUpdated"
                );
            }

            // climatisation
            if (
                this.idData.climatisation.climatisationStatus.value
                    .climatisationState === "off" &&
                this.idDataOld.climatisation.climatisationStatus.value
                    .climatisationState !== "off"
            ) {
                module.exports.idStatusEmitter.emit("climatisationStopped");
            }
            if (
                this.idData.climatisation.climatisationStatus.value
                    .climatisationState !== "off" &&
                this.idDataOld.climatisation.climatisationStatus.value
                    .climatisationState === "off"
            ) {
                module.exports.idStatusEmitter.emit("climatisationStarted");
            }
            if (
                this.idData.climatisation.climatisationStatus.value
                    .climatisationState === "cooling" &&
                this.idDataOld.climatisation.climatisationStatus.value
                    .climatisationState !== "cooling"
            ) {
                module.exports.idStatusEmitter.emit(
                    "climatisationCoolingStarted"
                );
            }
            if (
                this.idData.climatisation.climatisationStatus.value
                    .climatisationState === "heating" &&
                this.idDataOld.climatisation.climatisationStatus.value
                    .climatisationState !== "heating"
            ) {
                module.exports.idStatusEmitter.emit(
                    "climatisationHeatingStarted"
                );
            }
            if (
                this.idData.climatisation.climatisationSettings.value
                    .targetTemperature_C !==
                this.idDataOld.climatisation.climatisationSettings.value
                    .targetTemperature_C
            ) {
                module.exports.idStatusEmitter.emit(
                    "climatisationTemperatureUpdated"
                );
            }
            if (
                this.idData.climatisation.climatisationSettings.value
                    .climatizationAtUnlock !==
                this.idDataOld.climatisation.climatisationSettings.value
                    .climatizationAtUnlock
            ) {
                module.exports.idStatusEmitter.emit(
                    "climatisationAtUnlockUpdated"
                );
            }
            if (
                this.idData.climatisation.climatisationSettings.value
                    .windowHeatingEnabled !==
                this.idDataOld.climatisation.climatisationSettings.value
                    .windowHeatingEnabled
            ) {
                module.exports.idStatusEmitter.emit(
                    "windowHeatingUpdated"
                );
            }
            if (
                this.idData.climatisation.climatisationSettings.value
                    .zoneFrontLeftEnabled !==
                this.idDataOld.climatisation.climatisationSettings.value
                    .zoneFrontLeftEnabled
            ) {
                module.exports.idStatusEmitter.emit(
                    "zoneFrontLeftUpdated"
                );
            }
            if (
                this.idData.climatisation.climatisationSettings.value
                    .zoneFrontRightEnabled !==
                this.idDataOld.climatisation.climatisationSettings.value
                    .zoneFrontRightEnabled
            ) {
                module.exports.idStatusEmitter.emit(
                    "zoneFrontRightUpdated"
                );
            }

            if (this.config.backendError) {
                this.log.info(
                    "Current car state back in sync with VW backend."
                );
                module.exports.idStatusEmitter.emit(
                    "backendError",
                    false
                );
                this.config.backendError = false;
            }
        } catch (err) {
            if (!this.config.backendError) {
                this.log.error(
                    "Current car state not (correctly) received from VW backend."
                );
                this.log.debug(err);
                module.exports.idStatusEmitter.emit("backendError", true);
                this.config.backendError = true;
            }
        }
    }

    populateConfig() {
        this.log.debug("START populateConfig");

        try {
            this.config.targetTempC =
                this.idData.climatisation.climatisationSettings.value
                    .targetTemperature_C;
            this.config.targetSOC =
                this.idData.charging.chargingSettings.value.targetSOC_pct;
            this.config.chargeCurrent =
                this.idData.charging.chargingSettings.value.maxChargeCurrentAC;
            this.config.autoUnlockPlug =
                this.idData.charging.chargingSettings.value
                    .autoUnlockPlugWhenCharged === "permanent";
            this.config.climatizationAtUnlock =
                this.idData.climatisation.climatisationSettings.value
                    .climatizationAtUnlock;
            this.config.climatisationWindowHeating =
                this.idData.climatisation.climatisationSettings.value
                    .windowHeatingEnabled;
            this.config.climatisationFrontLeft =
                this.idData.climatisation.climatisationSettings.value
                    .zoneFrontLeftEnabled;
            this.config.climatisationFrontRight =
                this.idData.climatisation.climatisationSettings.value
                    .zoneFrontRightEnabled;
        } catch (e) {
            this.log.error("populateConfig failed");
            this.log.error(e);
        }

        this.log.debug("END populateConfig");
    }

    async getIdStatus(vin) {
        this.log.debug("[IDStatus] START getIdStatus for VIN " + vin);

        const url =
            "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" +
            vin +
            "/selectivestatus?jobs=access,activeVentilation,auxiliaryHeating,batteryChargingCare,batterySupport,charging,chargingProfiles,climatisation,climatisationTimers,departureProfiles,fuelStatus,honkAndFlash,hybridCarAuxiliaryHeating,userCapabilities,vehicleHealthWarnings,vehicleHealthInspection,vehicleLights,measurements,departureTimers";

        const headers = {
            accept: "*/*",
            "content-type": "application/json",
            "content-version": "1",
            "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
            "user-agent": this.userAgent,
            "accept-language": "de-de",
            authorization: "Bearer " + this.config.atoken
        };

        const callOnce = async () => {
            return this._req({
                method: "GET",
                url,
                headers,
                followAllRedirects: true,
                gzip: true,
                json: true
            });
        };

        try {
            // eerste poging
            let { resp, body } = await callOnce();

            if (resp.statusCode === 401) {
                this.log.debug("[IDStatus] 401 → performing full login()");
                await this._loginOnceGuarded("getIdStatus 401");

                // tweede poging na login
                ({ resp, body } = await callOnce());

                if (resp.statusCode === 401) {
                    this.log.debug("[IDStatus] 401 again after relogin → giving up");
                    throw new Error("auth-failed");
                }
            }

            if (resp.statusCode >= 400) {
                this.log.debug("[IDStatus] HTTP " + resp.statusCode);
                this.log.debug("[IDStatus] Body: " + JSON.stringify(body));
                throw new Error("getIdStatus HTTP " + resp.statusCode);
            }

            if (typeof body !== "object" || body === null) {
                this.log.debug("[IDStatus] Invalid JSON body");
                throw new Error("invalid-json");
            }

            if (this.idData) {
                this.idDataOld = this.idData;
            }

            this.idData = body;

            // parking info erbij plakken indien bekend
            if (this.idParkingPosition) {
                this.idData.parking = { ...this.idParkingPosition };
            }

            await this.runEventEmitters();
            this.boolFinishIdData = true;

            this.log.debug("[IDStatus] Success for VIN " + vin);
        } catch (err) {
            this.log.debug("[IDStatus] Error: " + err);
            throw err;
        }
    }




    async getIdParkingPosition(vin) {
        if (!this.hasParkingPosition(vin)) {
            this.log.debug("[Parking] VIN " + vin + " has no parkingPosition capability");
            return;
        }

        const url =
            "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" +
            vin +
            "/parkingposition";

        const headers = {
            accept: "*/*",
            "content-type": "application/json",
            "content-version": "1",
            "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
            "user-agent": this.userAgent,
            "accept-language": "de-de",
            authorization: "Bearer " + this.config.atoken
        };

        const callOnce = async () => {
            return this._req({
                method: "GET",
                url,
                headers,
                followAllRedirects: true,
                gzip: true,
                json: true
            });
        };

        try {
            this.log.debug("[Parking] GET " + url);

            // eerste poging
            let { resp, body } = await callOnce();

            if (resp.statusCode === 401) {
                this.log.debug("[Parking] 401 → performing full login()");
                await this._loginOnceGuarded("getIdParkingPosition 401");

                // tweede poging na login
                ({ resp, body } = await callOnce());

                if (resp.statusCode === 401) {
                    this.log.debug("[Parking] 401 again after relogin → giving up");
                    throw new Error("auth-failed");
                }
            }

            if (resp.statusCode >= 400) {
                this.log.debug("[Parking] HTTP " + resp.statusCode);
                this.log.debug("[Parking] Body: " + JSON.stringify(body));
                throw new Error("getIdParkingPosition HTTP " + resp.statusCode);
            }

            if (!body) {
                this.log.debug("[Parking] Empty body");
                this.idParkingPosition = { data: { carIsParked: false } };
                return;
            }

            this.idParkingPosition = body;
            if (!this.idParkingPosition.data) {
                this.idParkingPosition.data = {};
            }
            this.idParkingPosition.data.carIsParked = true;

            this.log.debug("[Parking] Success for VIN " + vin);
        } catch (err) {
            this.log.debug("[Parking] Error: " + err);
            throw err;
        }
    }




    setIdRemote(vin, action, value, bodyContent, isRetry = false) {
        return new Promise((resolve, reject) => {
            this.log.debug("setIdRemote >> " + action + "/" + value + " (retry=" + isRetry + ")");

            let body = bodyContent || {};

            if (action === "climatisation" && value === "settings") {
                const climateStates =
                    this.idData.climatisation.climatisationSettings.value;
                body = {};
                const allIds = Object.keys(climateStates);
                allIds.forEach((keyName) => {
                    let key = keyName.split(".").splice(-1)[0];

                    if (key === "targetTemperature_C") {
                        key = "targetTemperature";
                        if (
                            this.config.targetTempC >= 16 &&
                            this.config.targetTempC <= 27
                        ) {
                            climateStates[keyName] = this.config.targetTempC;
                        } else if (this.config.targetTempC !== -1) {
                            this.log.error(
                                "Cannot set temperature to " +
                                this.config.targetTempC +
                                "°C."
                            );
                            reject(
                                new Error(
                                    "Invalid temperature " +
                                    this.config.targetTempC
                                )
                            );
                            return;
                        }
                    }

                    if (
                        key === "targetTemperature_K" ||
                        key === "targetTemperature_F"
                    ) {
                        return;
                    }

                    if (key === "unitInCar") {
                        key = "targetTemperatureUnit";
                    }

                    if (key === "climatizationAtUnlock") {
                        climateStates[keyName] =
                            this.config.climatizationAtUnlock;
                    }
                    if (key === "windowHeatingEnabled") {
                        climateStates[keyName] =
                            this.config.climatisationWindowHeating;
                    }
                    if (key === "zoneFrontLeftEnabled") {
                        climateStates[keyName] =
                            this.config.climatisationFrontLeft;
                    }
                    if (key === "zoneFrontRightEnabled") {
                        climateStates[keyName] =
                            this.config.climatisationFrontRight;
                    }

                    if (!key.includes("Timestamp")) {
                        body[key] = climateStates[keyName];
                    }
                });
                body["climatisationWithoutExternalPower"] = true;

                this.config.pendingRequests = Math.max(
                    this.config.pendingRequests - 1,
                    0
                );
            }

            if (action === "charging" && value === "settings") {
                const chargingStates =
                    this.idData.charging.chargingSettings.value;
                body = {};
                const allIds = Object.keys(chargingStates);
                allIds.forEach((keyName) => {
                    const key = keyName.split(".").splice(-1)[0];
                    if (
                        this.config.targetSOC >= 50 &&
                        this.config.targetSOC <= 100
                    ) {
                        if (key === "targetSOC_pct") {
                            chargingStates[keyName] = this.config.targetSOC;
                        }
                    }
                    if (
                        this.config.chargeCurrent === "maximum" ||
                        this.config.chargeCurrent === "reduced"
                    ) {
                        if (key === "maxChargeCurrentAC") {
                            chargingStates[keyName] =
                                this.config.chargeCurrent;
                        }
                    }
                    if (key === "autoUnlockPlugWhenCharged") {
                        chargingStates[keyName] = this.config.autoUnlockPlug
                            ? "permanent"
                            : "off";
                    }
                    if (!key.includes("Timestamp")) {
                        body[key] = chargingStates[keyName];
                    }
                });
                this.config.pendingRequests = Math.max(
                    this.config.pendingRequests - 1,
                    0
                );
            }

            let method = "POST";
            if (value === "settings" || action === "destinations") {
                method = "PUT";
            }

            let urlString =
                "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" +
                vin +
                "/" +
                action +
                "/" +
                value;
            if (action === "destinations") {
                urlString =
                    "https://emea.bff.cariad.digital/vehicle/v1/vehicles/" +
                    vin +
                    "/" +
                    action;
            }

            this.log.debug("setIdRemote URL: " + urlString);
            this.log.debug("setIdRemote body: " + JSON.stringify(body));

            request(
                {
                    method,
                    url: urlString,
                    headers: {
                        "content-type": "application/json",
                        accept: "*/*",
                        "accept-language": "de-de",
                        "user-agent": this.userAgent,
                        "content-version": "1",
                        "x-newrelic-id": "VgAEWV9QDRAEXFlRAAYPUA==",
                        authorization: "Bearer " + this.config.atoken
                    },
                    body,
                    followAllRedirects: true,
                    json: true,
                    gzip: true
                },
                (err, resp, bodyResp) => {
                    if (err || (resp && resp.statusCode >= 400)) {
                        if (resp && resp.statusCode === 401) {
                            this.log.warn(
                                "[setIdRemote] 401 for " +
                                action +
                                "/" +
                                value +
                                (isRetry ? " after retry" : "")
                            );

                            if (isRetry) {
                                this.log.error("[setIdRemote] 401 after relogin → giving up");
                                err && this.log.error(err);
                                bodyResp &&
                                    this.log.error(JSON.stringify(bodyResp));
                                reject(err || new Error("401 after retry"));
                                return;
                            }

                            // één keer een full login en daarna retry
                            this._loginOnceGuarded("setIdRemote 401")
                                .then(() => {
                                    this.setIdRemote(vin, action, value, bodyContent, true)
                                        .then(resolve)
                                        .catch(reject);
                                })
                                .catch((loginErr) => {
                                    this.log.error(
                                        "[setIdRemote] Login failed during 401 handling: " +
                                        loginErr
                                    );
                                    reject(loginErr);
                                });
                            return;
                        }

                        err && this.log.error(err);
                        resp &&
                            this.log.error(resp.statusCode.toString());
                        bodyResp &&
                            this.log.error(JSON.stringify(bodyResp));
                        reject(err || new Error("setIdRemote failed"));
                        return;
                    }

                    try {
                        this.log.debug("setIdRemote response: " + JSON.stringify(bodyResp));
                        resolve();
                    } catch (e) {
                        this.log.error(e);
                        reject(e);
                    }
                }
            );
        });
    }

    hasParkingPosition(vin) {
        const list = Array.isArray(this.vehicles)
            ? this.vehicles
            : this.vehicles && Array.isArray(this.vehicles.data)
                ? this.vehicles.data
                : [];
        if (!Array.isArray(list)) return false;

        const vehicle = list.find((v) => v && v.vin === vin);
        if (!vehicle || !Array.isArray(vehicle.capabilities)) return false;

        return vehicle.capabilities.some(
            (c) => c && c.id === "parkingPosition"
        );
    }

    onUnload() {
        try {
            this.log.debug("cleaned everything up...");
            clearInterval(this.updateInterval);
            this.log.debug("onUnload: Success");
        } catch (e) {
            this.log.error("onUnload: Error");
        }
    }
}

module.exports.VwWeConnect = VwWeConnect;
module.exports.Log = Log;

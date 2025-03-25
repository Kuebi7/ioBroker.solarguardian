"use strict";

const utils = require("@iobroker/adapter-core");
const axios = require("axios");

class Solarguardian extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "solarguardian",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  async onReady() {
    this.setState("info.connection", false, true);

    // Konfigurationswerte auslesen
    const { appKey, appSecret, pollInterval } = this.config;

    if (!appKey || !appSecret) {
      this.log.error("appKey und appSecret müssen in der Konfiguration angegeben werden!");
      return;
    }

    try {
      // Token abrufen
      const token = await this.getAuthToken(appKey, appSecret);
      this.setState("info.connection", true, true);
      this.log.info("Erfolgreich mit Solarguardian API verbunden");

      // Daten abrufen und speichern
      await this.fetchData(token);

      // Regelmäßiges Polling einrichten
      this.pollingInterval = setInterval(() => this.fetchData(token), pollInterval);
    } catch (error) {
      this.log.error(`Fehler bei der Initialisierung: ${error.message}`);
      this.setState("info.connection", false, true);
    }
  }

  async getAuthToken(appKey, appSecret) {
    const url = "https://openapi.epsolarpv.com/epCloud/user/getAuthToken";
    const response = await axios.post(
      url,
      { appKey, appSecret },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data.status !== 0) {
      throw new Error(`Token-Anfrage fehlgeschlagen: ${response.data.info}`);
    }

    return response.data.data["X-Access-Token"];
  }

  async fetchData(token) {
    try {
      // Beispiel: Kraftwerksliste abrufen
      const url = "https://openapi.epsolarpv.com/epCloud/vn/openApi/getPowerStationListPage";
      const response = await axios.post(
        url,
        { powerStationName: "", pageNo: 1, pageSize: 10 },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Access-Token": token,
          },
        }
      );

      if (response.data.status === 0) {
        const powerStations = response.data.data.list;
        this.log.info(`Erfolgreich ${powerStations.length} Kraftwerke abgerufen`);

        // Daten in ioBroker speichern
        for (const station of powerStations) {
          const basePath = `powerStations.${station.id}`;
          await this.setObjectNotExistsAsync(`${basePath}.name`, {
            type: "state",
            common: { name: "Name", type: "string", role: "value", read: true, write: false },
            native: {},
          });
          await this.setObjectNotExistsAsync(`${basePath}.alarmStatus`, {
            type: "state",
            common: { name: "Alarm Status", type: "number", role: "value", read: true, write: false },
            native: {},
          });
          await this.setStateAsync(`${basePath}.name`, station.powerStationName, true);
          await this.setStateAsync(`${basePath}.alarmStatus`, station.alarmStatus, true);
        }
      } else {
        this.log.warn(`Datenabfrage fehlgeschlagen: ${response.data.info}`);
      }
    } catch (error) {
      this.log.error(`Fehler beim Abrufen der Daten: ${error.message}`);
    }
  }

  onUnload(callback) {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.setState("info.connection", false, true);
    this.log.info("Adapter wird beendet");
    callback();
  }
}

if (require.main !== module) {
  module.exports = (options) => new Solarguardian(options);
} else {
  new Solarguardian();
}

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
    this.baseUrl = "https://openapi.epsolarpv.com";
  }

  async onReady() {
    this.setState("info.connection", false, true);

    const { appKey, appSecret, pollInterval } = this.config;

    if (!appKey || !appSecret) {
      this.log.error("appKey und appSecret müssen in der Konfiguration angegeben werden!");
      return;
    }

    try {
      const token = await this.getAuthToken(appKey, appSecret);
      this.setState("info.connection", true, true);
      this.log.info("Erfolgreich mit Solarguardian API verbunden");

      // Alle Daten abrufen
      await this.fetchAllData(token);

      // Regelmäßiges Polling
      this.pollingInterval = setInterval(() => this.fetchAllData(token), pollInterval || 300000);
    } catch (error) {
      this.log.error(`Fehler bei der Initialisierung: ${error.message}`);
      this.setState("info.connection", false, true);
    }
  }

  async getAuthToken(appKey, appSecret) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/user/getAuthToken`,
      { appKey, appSecret },
      { headers: { "Content-Type": "application/json" } }
    );
    if (response.data.status !== 0) throw new Error(response.data.info);
    return response.data.data["X-Access-Token"];
  }

  async fetchAllData(token) {
    const headers = {
      "Content-Type": "application/json",
      "X-Access-Token": token,
    };

    try {
      // 1. Kraftwerke (Power Stations)
      await this.fetchPowerStations(headers);

      // 2. Gateways
      await this.fetchGateways(headers);

      // 3. Geräte (Devices)
      await this.fetchDevices(headers);

      // 4. Organisationen
      await this.fetchOrganizations(headers);

      // 5. Parameter und historische Daten (für jedes Gerät)
      await this.fetchDeviceParametersAndHistory(headers);

      // 6. Alarmhistorie
      await this.fetchAlarmHistory(headers);

      this.log.info("Alle Daten erfolgreich abgerufen und gespeichert");
    } catch (error) {
      this.log.error(`Fehler beim Abrufen der Daten: ${error.message}`);
    }
  }

  async fetchPowerStations(headers) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/vn/openApi/getPowerStationListPage`,
      { powerStationName: "", pageNo: 1, pageSize: 100 },
      { headers }
    );
    if (response.data.status === 0) {
      const stations = response.data.data.list;
      for (const station of stations) {
        const basePath = `powerStations.${station.id}`;
        await this.setObjectNotExistsAsync(basePath, { type: "device", common: { name: station.powerStationName }, native: {} });
        await this.setStateAsync(`${basePath}.name`, station.powerStationName, true);
        await this.setStateAsync(`${basePath}.alarmStatus`, station.alarmStatus, true);
        await this.setStateAsync(`${basePath}.equipmentCount`, station.equipmentCount, true);
        await this.setStateAsync(`${basePath}.equipmentOnlineCount`, station.equipmentOnlineCount, true);
      }
      this.log.info(`Abgerufen: ${stations.length} Kraftwerke`);
    }
  }

  async fetchGateways(headers) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/vn/openApi/getDevs`,
      { search_param: "", searchByDeviceStatus: "", page_param: { offset: 0, limit: 100 } },
      { headers }
    );
    if (response.data.status === 0) {
      const gateways = response.data.data.dev;
      for (const gateway of gateways) {
        const basePath = `gateways.${gateway.id}`;
        await this.setObjectNotExistsAsync(basePath, { type: "device", common: { name: gateway.name }, native: {} });
        await this.setStateAsync(`${basePath}.name`, gateway.name, true);
        await this.setStateAsync(`${basePath}.sn`, gateway.devid, true);
        await this.setStateAsync(`${basePath}.onlineStatus`, gateway.onlineStatus, true);
        await this.setStateAsync(`${basePath}.powerStationName`, gateway.powerStationName, true);
      }
      this.log.info(`Abgerufen: ${gateways.length} Gateways`);
    }
  }

  async fetchDevices(headers) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/vn/openApi/getEquipmentList`,
      { equipmentName: "", pageNo: 1, pageSize: 100 },
      { headers }
    );
    if (response.data.status === 0) {
      const devices = response.data.data.list;
      for (const device of devices) {
        const basePath = `devices.${device.id}`;
        await this.setObjectNotExistsAsync(basePath, { type: "device", common: { name: device.equipmentName }, native: {} });
        await this.setStateAsync(`${basePath}.name`, device.equipmentName, true);
        await this.setStateAsync(`${basePath}.serialNumber`, device.equipmentNo, true);
        await this.setStateAsync(`${basePath}.status`, device.status, true);
        await this.setStateAsync(`${basePath}.powerStationId`, device.powerStationId, true);
        await this.setStateAsync(`${basePath}.gatewayId`, device.gatewayId, true);
      }
      this.log.info(`Abgerufen: ${devices.length} Geräte`);
      return devices; // Für spätere Parameterabfragen
    }
    return [];
  }

  async fetchOrganizations(headers) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/vn/openApi/queryOrganizationList`,
      { isTree: 1 },
      { headers }
    );
    if (response.data.status === 0) {
      const orgs = response.data.data;
      for (const org of orgs) {
        const basePath = `organizations.${org.id}`;
        await this.setObjectNotExistsAsync(basePath, { type: "folder", common: { name: org.projectName }, native: {} });
        await this.setStateAsync(`${basePath}.name`, org.projectName, true);
        await this.setStateAsync(`${basePath}.level`, org.level, true);
        await this.setStateAsync(`${basePath}.parentId`, org.parentId || 0, true);
      }
      this.log.info(`Abgerufen: ${orgs.length} Organisationen`);
    }
  }

  async fetchDeviceParametersAndHistory(headers) {
    const devices = await this.fetchDevices(headers); // Geräte zuerst abrufen
    for (const device of devices) {
      // Parameter abrufen
      const paramResponse = await axios.post(
        `${this.baseUrl}/epCloud/vn/openApi/getEquipment`,
        { id: device.id },
        { headers }
      );
      if (paramResponse.data.status === 0) {
        const params = paramResponse.data.data.variableGroupList || [];
        const basePath = `devices.${device.id}.parameters`;
        for (const group of params) {
          for (const param of group.variableList) {
            const paramPath = `${basePath}.${param.dataPointId}`;
            await this.setObjectNotExistsAsync(paramPath, { type: "channel", common: { name: param.variableNameC }, native: {} });
            await this.setStateAsync(`${paramPath}.name`, param.variableNameC, true);
            await this.setStateAsync(`${paramPath}.unit`, param.unit || "", true);
            await this.setStateAsync(`${paramPath}.value`, "N/A", true); // Platzhalter, wird später aktualisiert
          }
        }

        // Historische Daten abrufen (Beispiel: letzter Wert)
        for (const group of params) {
          for (const param of group.variableList) {
            const historyResponse = await axios.post(
              `${this.baseUrl}/epCloud/vn/openApi/getDeviceDataPointHistory`,
              {
                devDatapoints: {
                  deviceNo: device.gatewayId,
                  slaveIndex: device.trafficStationNo,
                  itemId: param.itemId,
                  dataPointId: param.dataPointId,
                },
                start: Date.now() - 24 * 60 * 60 * 1000, // Letzte 24 Stunden
                end: Date.now(),
                pageNo: 1,
                pageSize: 1,
                timeSort: "desc",
              },
              { headers }
            );
            if (historyResponse.data.status === 0 && historyResponse.data.data[0]?.list?.length) {
              const latest = historyResponse.data.data[0].list[0];
              await this.setStateAsync(`${basePath}.${param.dataPointId}.value`, latest.value, true);
              await this.setStateAsync(`${basePath}.${param.dataPointId}.timestamp`, latest.time, true);
            }
          }
        }
      }
    }
    this.log.info("Parameter und historische Daten abgerufen");
  }

  async fetchAlarmHistory(headers) {
    const response = await axios.post(
      `${this.baseUrl}/epCloud/vn/openApi/getAlarmHistory`,
      { pageNo: 1, pageSize: 100, timeStart: Date.now() - 7 * 24 * 60 * 60 * 1000, timeEnd: Date.now() },
      { headers }
    );
    if (response.data.status === 0) {
      const alarms = response.data.data.list;
      for (const alarm of alarms) {
        const basePath = `alarms.${alarm.hid}`;
        await this.setObjectNotExistsAsync(basePath, { type: "state", common: { name: alarm.content }, native: {} });
        await this.setStateAsync(`${basePath}.content`, alarm.content, true);
        await this.setStateAsync(`${basePath}.deviceName`, alarm.deviceName, true);
        await this.setStateAsync(`${basePath}.createTime`, alarm.createTime, true);
        await this.setStateAsync(`${basePath}.status`, alarm.status, true);
      }
      this.log.info(`Abgerufen: ${alarms.length} Alarme`);
    }
  }

  onUnload(callback) {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
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

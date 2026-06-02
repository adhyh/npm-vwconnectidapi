# npm-vwconnectidapi

Volkswagen has recently changed its authentication and API access mechanisms, preventing third-party applications from obtaining the tokens required to access vehicle data.

As a result, this packahe is currently not working and cannot retrieve data from Volkswagen vehicles.

Based on the information currently available, there is no feasible workaround or alternative authentication method that would restore functionality without changes from Volkswagen. The issue is caused by changes on Volkswagen’s side and cannot be resolved within this project.

We are monitoring the situation and will update the package if Volkswagen provides a supported way to access vehicle data again.


NPM package for a We Connect ID API based on https://github.com/TA2k/ioBroker.vw-connect  
and https://github.com/nightsha-de/npm-vwconnectapi

Clone this repository to $path and use
```
sudo npm install -g npm-vwconnectidapi
```
to install.

### Example code:

```javascript
const api = require('npm-vwconnectidapi');
const idStatusEmitter = api.idStatusEmitter;
var log = new api.Log();
var vwConn = new api.VwWeConnect();
vwConn.setLogLevel("INFO"); // optional, ERROR (default), INFO, WARN or DEBUG
vwConn.setCredentials("YourEmail", "YourPassword");

idStatusEmitter.on('currentSOC', (soc) =>  {
        console.log(soc);
});

vwConn.getData()
  .then(() => {
    
    vwConn.setActiveVin("the VIN of your ID"); // must exist in vwConn.vehicles
    //vwConn.startClimatisation().then(...)
    //vwConn.stopClimatisation().then(...)
    //vwConn.stopCharging().then(...)
    vwConn.startCharging()
      .then(() => {
        log.info("Charging started");
      })
      .catch(() => {
        log.error("Error while starting the charging");
      })
      .finally(() => {
        log.info("Exiting ...");
        vwConn.onUnload();
        process.exit(1);
      });
  })
  .catch(() => {
    log.error("something went wrong");
    process.exit(1);
  });
```

### Methods supplied by the API:
All methods work with promises.

#### vwConn.setCredentials(user, password)
Login credentials. Pin is not needed for the ID cars.

#### vwConn.setLogLevel(logLevel)
Set/change the log level to "DEBUG", "INFO" or "ERROR" (default).

#### vwConn.getData()
Fills all data objects. If the process is not explicitly exited after getData (see example) it will regularly update the data in a given interval.

#### vwConn.setActiveVin(VIN)
Sets the VIN that is used for climatisation and charging. Setting is mandatory before clima or charging actions, VIN needs to exists in the vwConn.vehicles data.

#### vwConn.startClimatisation()
Start the air-conditioning.

#### vwConn.setClimatisation(temperature)
Set climatisation temperature.

#### vwConn.setClimatisationSetting(setting, value)
setting can be: 
```climatizationAtUnlock```
```climatisationWindowHeating```
```climatisationWindowHeating```
```climatisationFrontLeft```
```climatisationFrontLeft```
```climatisationFrontRight```
```climatisationFrontRight```. Set to true or false.

#### vwConn.stopClimatisation()
Stop the air-conditioning.

#### vwConn.setChargingSetting(setting, value)
setting can be:
```targetSOC```: Target battery level in percent.
```chargeCurrent```: "maximum" of "reduced".
```autoUnlockPlug```: true or false, to automatically unlock plug when finished charging.

#### vwConn.setChargingSettings(targetSOC, maxChargeCurrent) -> soon to be deprecated in favor of vwConn.setChargingSetting
Change the target SOC and the maximum charge current ("maximum" or "reduced") for charging.

#### vwConn.startCharging()
Start charging.

#### vwConn.stopCharging()
Stop charging.

#### vwConn.setDestination(destination)
Sends a destination to the navigation system. 'destination' is a JS object with the following structure.
```
{
  destinations: [
    {
      poiProvider: "unknown",
      geoCoordinate: {
        longitude: 5.12345,
        latitude: 52.12345
      },
      destinationName: "Home",
      address: {
        country: "Nederland",
        street: "My Street 1",
        zipCode: "1234 AA",
        city: "My City"
      }
    }
  ]
}
```


#### Status changes emitted by the API:
'statusNotSafe' - car is parked and doors remain unlocked or windows opened for >5 minutes.  
'parked' - Car is parked. Emits parking position as argument.  
'notParked' - Car is on the move.  
'chargePurposeReached' - Target state of charge reached.  
'chargingStarted' - Charging started.  
'chargingStopped' - Charging stopped.  
'currentSOC' - Actuel state of charge changed. Emits SOC as argument.  
'climatisationStopped' - Climatisation.  
'climatisationStarted' - Climatisation started.  
'climatisationCoolingStarted' - Climatisation started cooling.  
'climatisationHeatingStarted' - Climatisation started heating.  
'climatisationTemperatureUpdated' - Target climatisation temperature changed.  

### Objects supplied by the API:

#### vwConn.vehicles - List of vehicles

#### vwConn.idData - Car data for the IDs


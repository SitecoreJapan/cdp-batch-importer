import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, read } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Buffer, Blob } from 'buffer';

import yargs from "yargs";
import chalk from 'chalk';
import * as dotenv from 'dotenv';
import log4js from "log4js";
import axios from 'axios';
import fetch from 'node-fetch';

import { convertCsvToJson, convertJsonArrayToText } from './utils/data_transformation.js';
import { createGuestRecords, createUUID, getGzipInfo } from './helper/cdp_batch_data.js';

/*
    log configuration
 */
const timestamp = (new Date()).toISOString().replaceAll("-", "").replaceAll("T", "").replaceAll(":", "").replaceAll(/\..+Z$/g, "");
log4js.configure({
    appenders: {
        logFile: { type: 'file', filename: `logs/batch-importer-${timestamp}.log` }
    },
    categories: {
        default: { appenders: [ 'logFile' ], level: 'all' }
    }
});
const logger = log4js.getLogger();

/* 
    dotenv setting
 */
dotenv.config();

/*
    get arguments
*/
const argv = yargs(process.argv).argv;
const file = argv.file;
const identifiers = argv.identifiers ? argv.identifiers.split(",") : [];
const subscriptions = argv.subscriptions ? argv.subscriptions.split(",") : [];
const pointOfSale = argv.pointOfSale;
const client_key = argv.CLIENT_KEY;
const api_token = argv.API_TOKEN;
console.log(chalk.green(`file = ${JSON.stringify(file)}`));
console.log(chalk.green(`identifiers = ${JSON.stringify(identifiers)}`));
console.log(chalk.green(`subscriptions = ${JSON.stringify(subscriptions)}`));
console.log(chalk.green(`pointOfSale = ${JSON.stringify(pointOfSale)}`));
console.log(chalk.green(`client_key = ${JSON.stringify(client_key)}`));
console.log(chalk.green(`api_token = ${JSON.stringify(api_token)}`));
logger.debug(`file = ${JSON.stringify(file)}`);
logger.debug(`identifiers = ${JSON.stringify(identifiers)}`);
logger.debug(`subscriptions = ${JSON.stringify(subscriptions)}`);
logger.debug(`pointOfSale = ${JSON.stringify(pointOfSale)}`);
logger.debug(`client_key = ${JSON.stringify(client_key)}`);
logger.debug(`api_token = ${JSON.stringify(api_token)}`);

/*
    Confirm file existance
*/
if(!file) process.exit()
if(!existsSync(file)) {
    console.log(chalk.red(`File does not exist \n${file}`));
    process.exit()
};

/*
    Transform CSV format to JSON
*/
let fileContent = await readFile(file, "utf-8");
let jsonContent = convertCsvToJson(fileContent);

/* 
    Build Guest data and save as a file
 */
// build guest records from 
let guestRecords = createGuestRecords(jsonContent, {mode: "upsert", identifiers: identifiers, subscriptions: subscriptions, pointOfSale: pointOfSale});
let jsonArrayText = convertJsonArrayToText(guestRecords);

// generated json array
let jsonArrayFileName = `${file.replaceAll(".csv", "")}_cdp_batch_${timestamp}.json`;
await writeFile(jsonArrayFileName, jsonArrayText);
logger.debug(`jsonArrayFileName(genrated json array file): ${jsonArrayFileName}`);

// generated gzip file
let gzipJsonArrayFileName = `${jsonArrayFileName}.gz`;
let gzippedJsonArrayBuffer = gzipSync(jsonArrayText);
await writeFile(gzipJsonArrayFileName, gzippedJsonArrayBuffer);
logger.debug(`gzipJsonArrayFileName(generated gzip file): ${gzipJsonArrayFileName}`);

// gzip info
let gzipInfo = getGzipInfo(gzippedJsonArrayBuffer);
logger.debug(`gzipInfo: ${JSON.stringify(gzipInfo)}`);
// let gzipInfoFileName = `${jsonArrayFileName}.gz.info.json`;
// await writeFile(gzipInfoFileName, JSON.stringify(gzipInfo, null, '\t'));

/* 
    API Authorization info
 */
let clientKey = process.env.CLIENT_KEY;
if (client_key) {
    clientKey = client_key;
}
let apiToken = process.env.API_TOKEN;
if (api_token) {
    apiToken = api_token;
}
console.log(chalk.green(`clientKey = ${clientKey}`));
console.log(chalk.green(`apiToken = ${apiToken}`));
logger.debug(`clientKey: ${clientKey}`);
logger.debug(`apiToken: ${apiToken}`);

/*
    API Request settings
 */
const baseUrl = process.env.API_ENDPOINT;
console.log(chalk.green(`baseUrl = ${baseUrl}`));
logger.debug(`baseUrl: ${baseUrl}`);

/* 
    Pre signed request
 */
let batchUUID = createUUID();
let presignedUrl = `${baseUrl}/v2/batches/${batchUUID}`;

// pre sign request info
let presignRequestInfo = {
    checksum: gzipInfo.checksum,
    size: gzipInfo.size,
    uuid: batchUUID,
    url: presignedUrl
};
// let batchInfoFileName = `${jsonArrayFileName}.batch.info.json`;
// await writeFile(batchInfoFileName, JSON.stringify(presignRequestInfo, null, '\t'));
logger.debug(`presignRequestInfo: ${JSON.stringify(presignRequestInfo)}`);

// execute presign request
let presignResult = await axios.put(presignRequestInfo.url, {
    checksum: presignRequestInfo.checksum,
    size: presignRequestInfo.size
}, {
    auth: {
        username: clientKey,
        password: apiToken
    },
    headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
}).catch(error => {
    logger.debug(`pre sign request error`);
    logger.debug(`error.message: ${error.message}`);
    logger.debug(`error.response.data: ${JSON.stringify(error.response.data)}`);
    logger.debug(`error.response.status: ${error.response.status}`);
    logger.debug(`error.response.headers: ${JSON.stringify(error.response.headers)}`);
    console.log(chalk.red(`pre sign request error`));
    console.log(chalk.red(`error.message: ${error.message}`));
    console.log(chalk.red(`error.response.data: ${JSON.stringify(error.response.data)}`));
    console.log(chalk.red(`error.response.status: ${error.response.status}`));
    console.log(chalk.red(`error.response.headers: ${JSON.stringify(error.response.headers)}`));
    /* 
        NOTE:
        not use process.exit() here. 
        if use it to stop, the process may ends befor writing the log by log4js
     */
});

// to avoid the process ends before writing the log, use if to confirm condeition instead using process.exit() to stop the process
if(presignResult) {
    console.log(chalk.green("pre sign request success"));
    logger.debug("pre sign request success");
    /* 
        Batch pre signed info
     */
    let batchPresignedInfo = presignResult.data;
    console.log(chalk.green(JSON.stringify(batchPresignedInfo)));
    logger.debug(`batchPresignedInfo: ${JSON.stringify(batchPresignedInfo)}`);

    /* 
        Upload Batch file
    */
    // upload request info
    let uploadRequestInfo = {
        ref: batchPresignedInfo.ref,
        href: batchPresignedInfo.location.href,
        md5: Buffer.from(gzipInfo.checksum, "hex").toString("base64") 
    }
    // let uploadInfoFileName = `${jsonArrayFileName}.upload.info.json`;
    // await writeFile(uploadInfoFileName, JSON.stringify(uploadRequestInfo, null, '\t'));
    logger.debug(`uploadRequestInfo: ${JSON.stringify(uploadRequestInfo)}`);

    // execute upload request
    
    let uploadUrl = uploadRequestInfo.href;
    console.log(chalk.green(`uploadUrl: ${uploadUrl}`));
    /*
        axios issue
        axios put binary is corrupted
        https://github.com/axios/axios/issues/1250
     */
    // let uploadResult = await axios.put(uploadUrl, gzippedJsonArrayBuffer, {
    //     headers: {
    //         "Accept": "application/json",
    //         "x-amz-server-side-encryption": "AES256",
    //         "Content-Md5": uploadRequestInfo.md5,
    //         'Content-Type': 'application/octet-stream'
    //     }
    // }).catch(error => {
    //     logger.debug(`upload file request error`);
    //     logger.debug(`error.message: ${error.message}`);
    //     logger.debug(`error.response.data: ${JSON.stringify(error.response.data)}`);
    //     logger.debug(`error.response.status: ${error.response.status}`);
    //     logger.debug(`error.response.headers: ${JSON.stringify(error.response.headers)}`);
    //     console.log(chalk.red(`upload file request error`));
    //     console.log(chalk.red(`error.message: ${error.message}`));
    //     console.log(chalk.red(`error.response.data: ${JSON.stringify(error.response.data)}`));
    //     console.log(chalk.red(`error.response.status: ${error.response.status}`));
    //     console.log(chalk.red(`error.response.headers: ${JSON.stringify(error.response.headers)}`));
    // });

    // use node-fetch instead of axios
    try {

        let uploadResult = await fetch(uploadUrl, {
            method: "PUT",
            body: gzippedJsonArrayBuffer,
            headers: {
                "Accept": "application/json",
                "x-amz-server-side-encryption": "AES256",
                "Content-Md5": uploadRequestInfo.md5
            }
        });
    
        if(uploadResult) {
            console.log(chalk.green("upload file request success"));
    
            let uploadedInfo = presignResult.data;
            logger.debug(`uploadedInfo: ${JSON.stringify(uploadedInfo)}`);
        }

    } catch (error) {
        console.log(chalk.red(error));
    }
    

}


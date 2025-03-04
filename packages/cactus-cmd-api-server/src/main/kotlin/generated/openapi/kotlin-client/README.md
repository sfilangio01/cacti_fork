# org.openapitools.client - Kotlin client library for Hyperledger Cactus API

Interact with a Cactus deployment through HTTP.

## Overview
This API client was generated by the [OpenAPI Generator](https://openapi-generator.tech) project.  By using the [openapi-spec](https://github.com/OAI/OpenAPI-Specification) from a remote server, you can easily generate an API client.

- API version: 2.1.0
- Package version: 
- Build package: org.openapitools.codegen.languages.KotlinClientCodegen

## Requires

* Kotlin 1.7.21
* Gradle 7.5

## Build

First, create the gradle wrapper script:

```
gradle wrapper
```

Then, run:

```
./gradlew check assemble
```

This runs all tests and packages the library.

## Features/Implementation Notes

* Supports JSON inputs/outputs, File inputs, and Form inputs.
* Supports collection formats for query parameters: csv, tsv, ssv, pipes.
* Some Kotlin and Java types are fully qualified to avoid conflicts with types defined in OpenAPI definitions.
* Implementation of ApiClient is intended to reduce method counts, specifically to benefit Android targets.

<a id="documentation-for-api-endpoints"></a>
## Documentation for API Endpoints

All URIs are relative to *http://localhost*

Class | Method | HTTP request | Description
------------ | ------------- | ------------- | -------------
*DefaultApi* | [**getHealthCheckV1**](docs/DefaultApi.md#gethealthcheckv1) | **GET** /api/v1/api-server/healthcheck | Can be used to verify liveness of an API server instance
*DefaultApi* | [**getOpenApiSpecV1**](docs/DefaultApi.md#getopenapispecv1) | **GET** /api/v1/api-server/get-open-api-spec | 
*DefaultApi* | [**getPrometheusMetricsV1**](docs/DefaultApi.md#getprometheusmetricsv1) | **GET** /api/v1/api-server/get-prometheus-exporter-metrics | Get the Prometheus Metrics


<a id="documentation-for-models"></a>
## Documentation for Models

 - [org.openapitools.client.models.CmdApiServerEndpointErrorResponse](docs/CmdApiServerEndpointErrorResponse.md)
 - [org.openapitools.client.models.HealthCheckResponse](docs/HealthCheckResponse.md)
 - [org.openapitools.client.models.MemoryUsage](docs/MemoryUsage.md)
 - [org.openapitools.client.models.WatchHealthcheckV1](docs/WatchHealthcheckV1.md)


<a id="documentation-for-authorization"></a>
## Documentation for Authorization


Authentication schemes defined for the API:
<a id="bearerTokenAuth"></a>
### bearerTokenAuth

- **Type**: HTTP basic authentication


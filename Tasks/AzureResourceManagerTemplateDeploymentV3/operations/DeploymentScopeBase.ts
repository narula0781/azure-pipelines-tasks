import tl = require("azure-pipelines-task-lib/task");

import armDeployTaskParameters = require("../models/TaskParameters");
import armResource = require("azure-arm-rest-v2/AzureServiceClientBase");
import utils = require("./Utils");
import { sleepFor } from 'azure-arm-rest-v2/webClient';
import { DeploymentParameters } from "./DeploymentParameters";
import azureGraph = require("azure-arm-rest-v2/azure-graph");

export class DeploymentScopeBase {
    protected deploymentParameters: DeploymentParameters;
    protected taskParameters: armDeployTaskParameters.TaskParameters;
    protected armClient: armResource.AzureServiceClientBase;
    private _spnName: string = null;

    constructor(armClient: armResource.AzureServiceClientBase, taskParameters: armDeployTaskParameters.TaskParameters, deploymentParameters?: DeploymentParameters) {
        this.taskParameters = taskParameters;
        this.armClient = armClient;
        this.deploymentParameters = deploymentParameters;
    }

    public async deploy(): Promise<void> {
        await this.createTemplateDeployment();
    }

    protected async getServicePrincipalName(): Promise<string> {
        try {
            var graphClient: azureGraph.GraphManagementClient = new azureGraph.GraphManagementClient(this.taskParameters.graphCredentials);
            var servicePrincipalObject = await graphClient.servicePrincipals.GetServicePrincipal(null);
            return !!servicePrincipalObject ? servicePrincipalObject.appDisplayName : "";    
        } catch (error) {
            tl.debug(tl.loc("ServicePrincipalFetchFailed", error));
            return "";
        }
    }

    protected async createTemplateDeployment() {
        console.log(tl.loc("CreatingTemplateDeployment"));
        var params: DeploymentParameters;
        if (this.taskParameters.templateLocation === "Linked artifact") {
            params = utils.getDeploymentDataForLinkedArtifact(this.taskParameters);
        } else if (this.taskParameters.templateLocation === "URL of the file") {
            params = await utils.getDeploymentObjectForPublicURL(this.taskParameters);
        } else {
            throw new Error(tl.loc("InvalidTemplateLocation"));
        }

        if(!!this.deploymentParameters){
            params.location = this.deploymentParameters.location;
        }

        this.deploymentParameters = params;
        await this.performAzureDeployment(3);
    }

    protected async performAzureDeployment(retryCount = 0): Promise<void> {

        if(!this._spnName) {
            this._spnName = await this.getServicePrincipalName();
        }
        
        if (this.deploymentParameters.properties["mode"] === "Validation") {
            return this.validateDeployment();
        } else {
            console.log(tl.loc("StartingDeployment"));
            return new Promise<void>((resolve, reject) => {
                this.taskParameters.deploymentName = this.taskParameters.deploymentName || utils.createDeploymentName(this.taskParameters);
                console.log(tl.loc("LogDeploymentName", this.taskParameters.deploymentName));
                this.armClient.deployments.createOrUpdate(this.taskParameters.deploymentName, this.deploymentParameters, (error, result, request, response) => {
                    if (error) {
                        if(this.taskParameters.deploymentScope === "Resource Group" && error.code == "ResourceGroupNotFound" && retryCount > 0){
                            return this.waitAndPerformAzureDeployment(retryCount);
                        }
                        utils.writeDeploymentErrors(this.taskParameters, error);
                        this.printServicePrincipalRoleAssignmentError(error);
                        return reject(tl.loc("CreateTemplateDeploymentFailed"));
                    }
                    if (result && result["properties"] && result["properties"]["outputs"] && utils.isNonEmpty(this.taskParameters.deploymentOutputs)) {
                        tl.setVariable(this.taskParameters.deploymentOutputs, JSON.stringify(result["properties"]["outputs"]));
                        console.log(tl.loc("AddedOutputVariable", this.taskParameters.deploymentOutputs));
                    }

                    console.log(tl.loc("CreateTemplateDeploymentSucceeded"));
                    resolve();
                });
            });
        }
    }

    private printServicePrincipalRoleAssignmentError(error: any) {
        if(!!error && error.statusCode == 403) {
            if(this.taskParameters.deploymentScope == "Resource Group") {
                tl.error(tl.loc("ServicePrincipalRoleAssignmentDetails", this._spnName, this.taskParameters.resourceGroupName));
            } else if(this.taskParameters.deploymentScope == "Subscription") {
                tl.error(tl.loc("ServicePrincipalRoleAssignmentDetails", this._spnName, this.taskParameters.subscriptionId));
            } else if(this.taskParameters.deploymentScope == "Management Group") {
                tl.error(tl.loc("ServicePrincipalRoleAssignmentDetails", this._spnName, this.taskParameters.managementGroupId));    
            }
        }
    }

    protected validateDeployment(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            console.log(tl.loc("StartingValidation"));
            this.deploymentParameters.properties["mode"] = "Incremental";
            this.taskParameters.deploymentName = this.taskParameters.deploymentName || utils.createDeploymentName(this.taskParameters);
            console.log(tl.loc("LogDeploymentName", this.taskParameters.deploymentName));
            this.armClient.deployments.validate(this.taskParameters.deploymentName, this.deploymentParameters, (error, result, request, response) => {
                if (error) {
                    return reject(tl.loc("CreateTemplateDeploymentValidationFailed", utils.getError(error)));
                }
                if (result.error) {
                    utils.writeDeploymentErrors(this.taskParameters, result.error);
                    return reject(tl.loc("CreateTemplateDeploymentFailed"));
                } else {
                    console.log(tl.loc("ValidDeployment"));
                    resolve();
                }
            });
        });
    }

    private async waitAndPerformAzureDeployment(retryCount): Promise<void> {
        await sleepFor(3);
        return this.performAzureDeployment(retryCount - 1);
    }
}
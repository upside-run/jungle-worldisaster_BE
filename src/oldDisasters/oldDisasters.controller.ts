import { Controller, Get, Param } from '@nestjs/common';
import { OldDisastersService } from './oldDisasters.service';
import { OldDisastersEntity } from './oldDisasters.entity';

@Controller('oldDisasters')
export class OldDisastersController {
    constructor(private readonly disastersService: OldDisastersService) { }

    /* Initial Server Setup API */

    @Get('forceSync')
    async debug_force_refresh(): Promise<{ success: boolean, message: string }> {
        // console.log("\nAPI : GET call made to force load oldDisasters DB (server setup)");
        return await this.disastersService.fetchAndStoreAllDisasters();
    }

    /* Actual API Implementation */

    @Get('/')
    async getAllDetails(): Promise<OldDisastersEntity[]> {
        // console.log("\nAPI : GET call made to fetch all oldDisasters detail");
        return await this.disastersService.getAllDisasters();
    }

    @Get('/country/:country')
    async getByCountry(@Param('country') country: string): Promise<OldDisastersEntity[]> {
        // console.log("\nAPI : GET call made to fetch all oldDisasters by country");

        if (country.length == 2) {
            return this.disastersService.getDisastersByCountryCode(country);
        } else {
            return this.disastersService.getDisastersByCountryName(country);
        }
    }

    @Get('/country/:country/:year')
    async getByCountryAndYear(@Param('country') country: string, @Param('year') year: string): Promise<OldDisastersEntity[]> {
        // console.log("\nAPI : GET call made to fetch all oldDisasters by country and year");

        if (country.length == 2) {
            return this.disastersService.getDisastersByCountryCodeAndYear(country, year);
        } else {
            return this.disastersService.getDisastersByCountryNameAndYear(country, year);
        }
    }

    @Get('/year/:year')
    async getByYear(@Param('year') year: string): Promise<OldDisastersEntity[]> {
        // console.log("\nAPI : GET call made to fetch all oldDisasters by year");

        return this.disastersService.getDisastersByYear(year);
    }

}

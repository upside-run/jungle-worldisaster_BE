import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Cron, CronExpression } from '@nestjs/schedule'; // 주기적인 Ping
import { HttpService } from '@nestjs/axios'; // Http 요청
import { parseStringPromise } from 'xml2js'; // XML 포맷 처리
import { firstValueFrom } from 'rxjs';

import { CountryMappings } from 'src/country/script_init/country-table.entity';
import { NewDisastersEntity } from './newDisasters.entity';
import { NewDisastersGateway } from './newDisasters.gateway';
import { EmailAlertsService } from 'src/emailAlerts/emailAlerts.service';

@Injectable()
export class NewDisastersService {

    /* 필요한 Reference들을 Import */
    constructor(
        private httpService: HttpService, // HTTP 요청 라이브러리를 가져오고
        private newDisastersGateway: NewDisastersGateway, // 재난 알림용 웹소켓 게이트웨이도 불러오고
        private emailAlertsService: EmailAlertsService, // 이메일 전송을 위한 서비스도 불러오고,

        @InjectRepository(CountryMappings) // CountryMappings 테이블도 불러오고
        private countryMappingRepository: Repository<CountryMappings>,

        @InjectRepository(NewDisastersEntity) // NewDisastersEntity 테이블도 불러오고
        private disasterDetailRepository: Repository<NewDisastersEntity>,
    ) { }

    /* API 대응용 함수들 (cc. newDisasters.service) */

    async getAllDisasters(): Promise<NewDisastersEntity[]> {
        return this.disasterDetailRepository.createQueryBuilder('disaster').getMany();
    }


    async getGdacsDisasterByID(dID: string): Promise<NewDisastersEntity | undefined> {
        return this.disasterDetailRepository.findOneBy({ dID });
    }

    async getGdacsDisastesByYear(year: string): Promise<NewDisastersEntity[]> {
        const allPastDisasters = await this.disasterDetailRepository
            .createQueryBuilder('disaster').getMany();

        return allPastDisasters.filter(disaster => {
            const date = new Date(disaster.dDate);
            return date.getFullYear().toString() === year;
        });
    }

    async getGdacsDisastesByYearAndStatus(year: string, status: string): Promise<NewDisastersEntity[]> {
        const allPastDisasters = await this.disasterDetailRepository
            .createQueryBuilder('disaster')
            .where('disaster.dStatus = :status', { status })
            .getMany();

        return allPastDisasters.filter(disaster => {
            const date = new Date(disaster.dDate);
            return date.getFullYear().toString() === year;
        });
    }

    async getDisastersByStatusService(status: string): Promise<NewDisastersEntity[]> {
        return this.disasterDetailRepository
            .createQueryBuilder('disaster')
            .where('disaster.dStatus = :status', { status })
            .getMany();
    }

    async getUrgentGdacsDisasters(): Promise<NewDisastersEntity[]> {
        return this.disasterDetailRepository
            .createQueryBuilder('disaster')
            .where('disaster.dStatus IN (:...statuses)', { statuses: ['real-time', 'ongoing'] })
            .andWhere('disaster.dAlertLevel IN (:...alertLevels)', { alertLevels: ['Red', 'Orange'] })
            .orderBy('CASE WHEN disaster.dStatus = \'real-time\' THEN 1 WHEN disaster.dStatus = \'ongoing\' THEN 2 END', 'ASC')
            .addOrderBy('CASE WHEN disaster.dAlertLevel = \'Red\' THEN 1 WHEN disaster.dAlertLevel = \'Orange\' THEN 2 END', 'ASC')
            .getMany();
    }

    /* 여기서부터는 주기적으로 RSS 피드를 확인하고 처리하는 역할 */

    @Cron(CronExpression.EVERY_30_SECONDS)
    async handleDisasterUpdate() {
        // console.log('\nGDACS Disaster Update Initiated...');

        try {
            // 보조 함수들을 통해서 실시간 RSS 피드 내역을 처리, Disasters 배열에 담기
            const rssFeedXml = await this.fetchRssFeed();
            const disasters = await this.parseRssFeed(rssFeedXml);
            // console.log(`${disasters.length} disasters in current GDACS feed...`);

            // 비교를 위해서 현재 DB에서 dStatus : real-time/ongoing/past 상태의 재난들을 배열에 담기
            const dbDisasters = await this.disasterDetailRepository.find({
                where: {
                    dStatus: In(['real-time', 'ongoing'])
                }
            });

            // db에 있는 재난들의 dID로 구성된 set를 하나 만들어서 dStatus 업데이트에 활용 (rss에 없다면 past)
            const dbDisasterIdSet = new Set(dbDisasters.map(d => d.dID));

            // 재난 발생 이메일을 보낼 때, 양이 많으면 논외처리해야 함
            const newDisastersForBroadcast: NewDisastersEntity[] = [];
            let disasterUpdateCount = 0;
            let disasterNewCount = 0;

            // 함수가 호출되는 현재 시각을 한번 정의
            const now = new Date();
            // console.log(`Current time is ${now.toString()}...`);

            // 본격적으로 새로운 disasters 배열의 개별 Element들을 하나씩 처리
            for (const disaster of disasters) {

                // 다른 작업에 앞서서, 24시간 이내의 재난이라면 real-time으로 dStatus 값을 변경해서 처리해야 함 (직전에 정의한 now와 비교)
                const disasterDate = new Date(disaster.dDate); // DB 시간은 UTC/GMT인데, TypeORM 및 Typescript가 알아서 서버 시간으로 변환
                const timeDifference = (now.getTime() - disasterDate.getTime()) / (1000 * 60 * 60); // msec을 sec, min, hr로 변환
                disaster.dStatus = timeDifference <= 24 ? 'real-time' : 'ongoing';

                // 만일 특정 재난이 이미 DB에 있는지 확인
                const existingDisaster = dbDisasters.find(d => d.dID === disaster.dID);

                if (existingDisaster) { // DB에 있다면,

                    // 각 칼럼들을 하나씩 순회하면서 비교해보고, 바꾸는게 있다면 shouldUpdate를 변경
                    let shouldUpdate = false;
                    for (const property in disaster) {

                        // Entity에서 위도 경도는 Floating Point이며, 매번 오차가 조금씩 발생해서 업데이트가 실행되어버림
                        if (property === 'dLatitude' || property === 'dLongitude') {
                            const existingValue = existingDisaster[property];
                            const newValue = disaster[property];

                            // 따라서 값이 재대로 있다는 전제 하에, 두 변수를 모두 강제로 자연수로 만들어서 간단하게 비교 (소수점 아래는 버림)
                            if (existingValue != null && newValue != null) {
                                const numExisting = Math.trunc(Number(existingValue));
                                const numNew = Math.trunc(Number(newValue));

                                if (numExisting !== numNew) {
                                    // console.log(`Updated ${property} -> Old value: ${numExisting}, New value: ${numNew}...`);
                                    existingDisaster[property] = disaster[property];
                                    shouldUpdate = true;
                                }
                            }
                        } else if (disaster[property] !== existingDisaster[property]) {
                            // 위도 경도 아닌 값이 바뀌었을 경우 여기서 처리 (단, dStatus는 검색하지 않으니 조심)

                            // console.log(`Field to update: ${property}, Old value: ${existingDisaster[property]}, New value: ${disaster[property]}...`);
                            existingDisaster[property] = disaster[property];
                            shouldUpdate = true;
                        }
                    }

                    // shouldUpdate 상태라면 업데이트 (TypeORM은 save시 Entity / PrimaryColumn으로 알아서 업데이트 처리)
                    if (shouldUpdate) {
                        await this.disasterDetailRepository.save(existingDisaster);
                        disasterUpdateCount++;
                        // console.log(`Updated disaster: ${disaster.dID}...`);
                    }

                } else { // DB에 없다면 새로 저장하고, 알림을 보낸 뒤 로그 남기기

                    try {
                        await this.disasterDetailRepository.save(disaster);
                        newDisastersForBroadcast.push(disaster);
                        disasterNewCount++
                        // console.log(`New disaster added to DB: ${disaster.dID}...`);

                    } catch (error) {
                        console.error('Error saving or broadcasting disaster:', error);
                    }
                }

                // 하나의 재난을 처리했으면, 해당 재난을 set에서 제거
                dbDisasterIdSet.delete(disaster.dID);
            }

            // 위 과정을 통해 set에 남아있는 재난이 있다면, 더이상 GDACS 7-day RSS에 없으니 past로 상태값 변경
            for (const dID of dbDisasterIdSet) {
                await this.disasterDetailRepository.update({ dID }, { dStatus: 'past' });
                // console.log(`Marked disaster as past: ${dID}.`);
            }

            // 마지막으로 실제 broadcast 진행 (웹소켓, 이메일)
            if (newDisastersForBroadcast.length <= 5) {
                for (const newDisaster of newDisastersForBroadcast) {
                    if (newDisaster.dStatus === 'real-time' || 'ongoing') {

                        // Timeout 5초 (다른 작업들 처리될 시간 주기))
                        setTimeout(async () => {
                            this.newDisastersGateway.sendDisasterWebsocketAlert(newDisaster);
                            await this.emailAlertsService.sendEmailAlert(newDisaster);
                            // console.log(`New disaster broadcasted via Websocket & Email for ${newDisaster.dID}...`);
                        }, 5000); // Delay in milliseconds, here it's set to 5 seconds
                    }
                }
            }

            // 함수 종료
            console.log(`GDACS Update Completed (${disasterNewCount} new and ${disasterUpdateCount} updated). \n`);
            return { success: true, message: 'Update Successful.' };

        } catch (error) {
            console.error('Error in handling disaster update:', error);
            return { success: false, message: 'Update Failed.' };
        }
    }

    /* handleDisasterUpdate()에서 필요한 RSS 피드 data 값을 추출하는 함수 */
    private async fetchRssFeed(): Promise<string> {
        const response = await firstValueFrom(this.httpService.get('https://gdacs.org/xml/rss_7d.xml'));
        if (!response.data) {
            console.error('Error fetching RSS feed');
        }
        return response.data;
    }

    /* handleDisasterUpdate()에서 fetchRssFeed() 이후 실제 파싱을 수행하는 함수 (<item>을 정리) */
    private async parseRssFeed(xmlData: string): Promise<any> {

        // 먼저 xmlData를 준비하고
        const parsedData = await parseStringPromise(xmlData);
        const items = parsedData.rss.channel[0].item;

        // 처리된 재난들을 담을 배열을 하나 준비한 뒤 각각의 <item>들을 하나씩 처리
        const disasters: NewDisastersEntity[] = [];
        for (const item of items) { // items.map(async item...)로 하면 더 빠르지만, 데이터가 일부 깨지는 현상 발견 (하나씩 처리 필요)

            // iso3가 값이 없는 경우를 대비 (보조함수 활용)
            const mapLat = parseFloat(item['geo:Point']?.[0]['geo:lat']?.[0]);
            const mapLong = parseFloat(item['geo:Point']?.[0]['geo:long']?.[0]);
            const mapIso3 = item['gdacs:iso3']?.[0];
            const { dCountry, dCountryCode, dCountryIso3 } // iso3 값 유무와 관계 없이 출력됨
                = await this.mapCountryOrOcean(mapIso3, mapLat, mapLong);

            // GDACS는 재난을 2글자 코드로만 관리하니, 풀네임으로 변환해야 함 (보조함수 활용)
            const dTypeCode = item['gdacs:eventtype']?.[0];
            const dType = this.mapDisasterType(dTypeCode);

            // 개별 Entry 생성
            const disaster = new NewDisastersEntity();
            Object.assign(disaster, {
                dID: item.guid?.[0]._ ?? null,
                dSource: 'GDACS',
                dStatus: 'ongoing',
                dAlertLevel: item['gdacs:alertlevel']?.[0],
                dSeverity: item['gdacs:severity']?.[0]._ ?? null,

                dCountry,
                dCountryCode,
                dCountryIso3,

                dType,
                dTypeCode,

                dDate: item['gdacs:fromdate']?.[0],
                dLatitude: item['geo:Point']?.[0]['geo:lat']?.[0], // 위에서 숫자로 변환해서 활용했지만, 저장은 string으로
                dLongitude: item['geo:Point']?.[0]['geo:long']?.[0],
                dTitle: item.title?.[0],
                dDescription: item.description?.[0],
                dUrl: item.link?.[0]
            });

            disasters.push(disaster);
        }

        return disasters;
    }

    private mapDisasterType(dTypeCode: string): string {
        // 에러처리를 보다 용이하게 하기 위해서 별도 보조 함수로 독립

        const disasterTypeMap = {
            'EQ': 'Earthquake',
            'TC': 'Tropical Cyclone',
            'FL': 'Flood',
            'VO': 'Volcano',
            'DR': 'Drought',
            'WF': 'Forest Fire'
        };
        if (dTypeCode in disasterTypeMap) {
            return disasterTypeMap[dTypeCode];
        } else {
            throw new Error(`Unknown disaster type code: ${dTypeCode}`);
        }
    }

    private mapToNearestOcean(latitude: number, longitude: number): string | null {
        // 에러처리를 보다 용이하게 하기 위해서 별도 보조 함수로 독립

        const oceanMapping = {
            'Pacific Ocean': { lat: { min: -60, max: 60 }, long: { min: 100, max: -70 } },
            'Atlantic Ocean': { lat: { min: -60, max: 60 }, long: { min: -70, max: 20 } },
            'Indian Ocean': { lat: { min: -60, max: 30 }, long: { min: 20, max: 100 } },
            'Arctic Ocean': { lat: { min: 60, max: 90 }, long: { min: -180, max: 180 } },
            'Southern Ocean': { lat: { min: -90, max: -60 }, long: { min: -180, max: 180 } },
        };

        for (let ocean in oceanMapping) {
            let range = oceanMapping[ocean];
            if (latitude >= range.lat.min && latitude <= range.lat.max &&
                (longitude >= range.long.min || longitude <= range.long.max)) {
                return ocean;
            }
        }

        return null;
    }

    private async mapCountryOrOcean(mapIso3: string | null, mapLat: number | null, mapLong: number | null
    ): Promise<{ dCountry: string | null, dCountryCode: string | null, dCountryIso3: string | null }> {
        // 에러처리를 보다 용이하게 하기 위해서 별도 보조 함수로 독립

        // dCountryIso3, 즉 <gdacs:iso3>이 빈 값 ('')을 제공하는 경우들이 있음 -> 문제가 없을 경우 아래 코드 실행
        if (mapIso3 && mapIso3.trim() !== '') {
            const countryEntity = await this.countryMappingRepository.findOne({ where: { iso3: mapIso3 } });
            if (countryEntity) {
                return {
                    dCountry: countryEntity.cia_name,
                    dCountryCode: countryEntity.code,
                    dCountryIso3: countryEntity.iso3
                };
            }
        }

        // iso3 코드가 없는 경우, 확인해보면 바다에 해당함 (International Territories)
        if (!isNaN(mapLat) && !isNaN(mapLong)) {
            const oceanName = this.mapToNearestOcean(mapLat, mapLong);
            if (oceanName) {
                const oceanEntity = await this.countryMappingRepository.findOne({ where: { cia_name: oceanName } });
                if (oceanEntity) {
                    return {
                        dCountry: oceanName,
                        dCountryCode: oceanEntity.code,
                        dCountryIso3: null // 바다는 iso3 코드가 없음
                    };
                }
            }
        }

        // iso3 값이 비어있는데 바다 매칭도 되지 않는 경우
        return { dCountry: null, dCountryCode: null, dCountryIso3: null };
    }

}

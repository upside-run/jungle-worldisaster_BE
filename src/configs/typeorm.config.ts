
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { CountryEntity } from '../country/country.entity';
import { CountryMappings } from '../country/script_init/country-table.entity';
import { OldDisastersEntity } from 'src/oldDisasters/oldDisasters.entity';
import { NewDisastersEntity } from 'src/newDisasters/newDisasters.entity';
import { ChatEntity } from 'src/chat/chat.entity';
import { LiveNewsEntity } from 'src/liveNews/liveNews.entity';
import { Video } from 'src/upload/video.entity';

export const typeORMConfig: TypeOrmModuleOptions = {
    type: 'postgres',
    host: process.env.AWS_HOST,
    port: 5432,
    username: process.env.AWS_USER,
    password: process.env.AWS_PWD,
    database: process.env.AWS_DBN,
    entities: [__dirname + '/../**/*.entity.{js,ts}',
        CountryMappings,
        CountryEntity,
        OldDisastersEntity,
        NewDisastersEntity,
        ChatEntity,
        LiveNewsEntity,
        Video
    ],
    synchronize: false // true값을주면 애플리케이션을 다시 실행할 때 엔티티안에서 수정된 컬럼의 길이 타입 변경값등을 해당 테이블을 drop한후 다시 생성해줌.
}
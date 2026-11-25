import { IsDateString, IsOptional, IsString } from 'class-validator';

export class GetInboxDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  @IsOptional()
  @IsString()
  integration?: string;
}

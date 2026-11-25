import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReplyInboxDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  text: string;
}
